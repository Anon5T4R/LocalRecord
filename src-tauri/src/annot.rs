//! Overlay de anotação AO VIVO (onda 3) — o PILAR do LocalRecord.
//!
//! É o que separa isto de um gravador de tela comum: o professor risca a tela
//! enquanto explica, e o risco entra no vídeo.
//!
//! ## Por que uma janela separada, e não um filtro no ffmpeg
//!
//! O `ddagrab` captura o que está NA TELA. Então uma janela transparente e
//! always-on-top por cima do monitor entra na gravação **de graça**: o
//! `filter_complex` (`args.ts`) não muda uma vírgula, e a plateia presencial —
//! a turma na sala, quem está do outro lado da chamada — vê a mesma coisa que
//! o vídeo. Desenhar dentro do ffmpeg não daria nenhuma das duas.
//!
//! Trade-off aceito: a anotação fica QUEIMADA no vídeo, não é faixa editável
//! depois. Coerente com a proposta ("anotar AO VIVO", não "editar na pós").
//!
//! ## O ponto crítico: click-through
//!
//! Uma janela cobrindo o monitor inteiro é, por padrão, uma parede: ela come
//! todo clique do usuário. Se o overlay ficasse assim, o usuário não
//! conseguiria mexer no app que está demonstrando — o LocalRecord viraria um
//! app que impede de gravar tutorial. Por isso `set_ignore_cursor_events(true)`
//! é o estado NORMAL do overlay; só a caneta ligada suspende ele.
//!
//! A regra inteira mora em `ignore_cursor()`, isolada e testada.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Rótulo da janela do overlay (declarada no `tauri.conf.json`).
pub const ANNOT_LABEL: &str = "annot";

/// Liga/desliga a caneta. Só vale enquanto o overlay está armado — atalho
/// global registrado no arm e LARGADO no disarm: um app de gravação não pode
/// confiscar Ctrl+Shift+D da máquina inteira o dia todo.
pub const SC_PEN: &str = "ctrl+shift+d";
/// Limpa tudo. Mesmo ciclo de vida do de cima.
pub const SC_CLEAR: &str = "ctrl+shift+x";

/// Estado do overlay. Dois bits, mas são os dois bits que mandam no mouse da
/// máquina inteira — por isso ficam num lugar só, com dono claro.
#[derive(Default)]
pub struct AnnotState {
    armed: AtomicBool,
    pen: AtomicBool,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AnnotSnapshot {
    pub armed: bool,
    pub pen: bool,
}

/// **A regra que faz o app funcionar.** O overlay só pode roubar o mouse quando
/// há caneta na mão; em qualquer outro estado, o clique ATRAVESSA e vai pro app
/// que está embaixo (que é o app sendo demonstrado).
///
/// Escrito como função pura de propósito: é a única linha de código do
/// LocalRecord que, errada, torna o produto inteiro inútil — e "abrir o app e
/// ver" não é jeito de garantir isso a cada mudança. Por isso tem teste.
pub fn ignore_cursor(armed: bool, pen: bool) -> bool {
    !(armed && pen)
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(ANNOT_LABEL)
        .ok_or_else(|| "janela de anotação não existe".to_string())
}

fn snapshot(state: &AnnotState) -> AnnotSnapshot {
    AnnotSnapshot {
        armed: state.armed.load(Ordering::SeqCst),
        pen: state.pen.load(Ordering::SeqCst),
    }
}

/// Cobre o monitor inteiro por posição+tamanho.
///
/// NÃO usa `set_fullscreen(true)` de propósito: fullscreen de verdade no Windows
/// entrega a tela pro app (o compositor tira todo o resto da frente), e aí o
/// overlay deixaria de ser overlay — ele TAPARIA o que deveria estar anotando.
/// Uma janela normal do tamanho do monitor, sem decoração, é o que preserva o
/// always-on-top por cima dos outros apps.
fn cover_screen(win: &WebviewWindow) -> Result<(), String> {
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .ok_or("nenhum monitor encontrado")?;
    win.set_position(*mon.position()).map_err(|e| e.to_string())?;
    win.set_size(*mon.size()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Arma/desarma o overlay: a janela aparece por cima da tela, mas TRANSPARENTE
/// pro mouse (caneta desligada). Armar não pode atrapalhar nada — o usuário
/// arma antes de começar a aula e esquece que existe até apertar o atalho.
#[tauri::command(async)]
pub fn annot_arm(app: AppHandle, state: State<'_, AnnotState>, on: bool) -> Result<AnnotSnapshot, String> {
    let win = window(&app)?;

    if on {
        // A caneta sempre nasce desligada. Armar com a caneta ligada faria o
        // overlay comer o primeiro clique do usuário — exatamente o desastre
        // que este módulo existe pra evitar.
        state.pen.store(false, Ordering::SeqCst);
        // ORDEM IMPORTA: click-through ANTES do show. Mostrar primeiro deixaria
        // uma janela-parede na frente de tudo por alguns quadros, e um clique
        // nesse intervalo morreria no overlay.
        win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        cover_screen(&win)?;
        win.set_always_on_top(true).map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        state.armed.store(true, Ordering::SeqCst);
        register_shortcuts(&app)?;
    } else {
        state.armed.store(false, Ordering::SeqCst);
        state.pen.store(false, Ordering::SeqCst);
        win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        win.hide().map_err(|e| e.to_string())?;
        unregister_shortcuts(&app);
    }

    let snap = snapshot(&state);
    let _ = app.emit("annot-state", snap);
    Ok(snap)
}

/// Liga/desliga a caneta — e o click-through junto. São a MESMA decisão: caneta
/// na mão = o overlay recebe o mouse; caneta guardada = o mouse passa reto.
/// Separar os dois só criaria o estado inútil "rouba o mouse e não desenha".
fn apply_pen(app: &AppHandle, on: bool) -> Result<AnnotSnapshot, String> {
    let state = app.state::<AnnotState>();
    if !state.armed.load(Ordering::SeqCst) {
        // Caneta sem overlay armado não existe; devolve o estado real em vez de
        // fingir que ligou.
        return Ok(snapshot(&state));
    }
    let win = window(app)?;
    win.set_ignore_cursor_events(ignore_cursor(true, on))
        .map_err(|e| e.to_string())?;
    state.pen.store(on, Ordering::SeqCst);
    if on {
        // Sem foco, o teclado da ferramenta de texto iria pro app de baixo.
        let _ = win.set_focus();
    }
    let snap = snapshot(&state);
    // Um `emit` só: as duas janelas ouvem. A `main` pra o botão refletir o
    // atalho global, a `annot` pra o canvas trocar de modo.
    let _ = app.emit("annot-state", snap);
    Ok(snap)
}

#[tauri::command(async)]
pub fn annot_set_pen(app: AppHandle, on: bool) -> Result<AnnotSnapshot, String> {
    apply_pen(&app, on)
}

/// Puxa o foco do teclado pro overlay. Chamado quando a ferramenta de TEXTO
/// abre a caixinha de digitar.
///
/// Existe por causa do `"focus": false` da janela (tauri.conf.json), que está
/// certo — o overlay é armado antes da aula e não pode roubar o foco de quem
/// está trabalhando. O efeito colateral é que clicar nele no Windows também
/// NÃO o ativa: a caixinha de texto aparecia, o cursor piscava nela, e as
/// teclas iam pro aplicativo de baixo. Foi o relato do João nos testes reais
/// ("eu clico aqui e não faz nada") — e a caneta escapava porque desenhar não
/// precisa de teclado.
///
/// Pedir o foco só ao digitar, e não ao ligar a caneta, mantém a promessa
/// original: quem só rabisca nunca perde o foco do que estava fazendo.
#[tauri::command(async)]
pub fn annot_focus(app: AppHandle) -> Result<(), String> {
    window(&app)?.set_focus().map_err(|e| e.to_string())
}

/// Estado real do overlay — pra UI reconciliar depois de um reload da webview
/// (mesmo motivo do `rec_status`: a verdade mora no Rust, não no React).
#[tauri::command(async)]
pub fn annot_state(state: State<'_, AnnotState>) -> AnnotSnapshot {
    snapshot(&state)
}

#[tauri::command(async)]
pub fn annot_clear(app: AppHandle) {
    let _ = app.emit("annot-clear", ());
}

fn register_shortcuts(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for sc in [SC_PEN, SC_CLEAR] {
        // Idempotente: armar duas vezes (toggle nervoso na UI) não pode virar
        // erro "shortcut já registrado" na cara do usuário.
        if gs.is_registered(sc) {
            continue;
        }
        gs.on_shortcut(sc, move |app, _shortcut, event| {
            // Sem este filtro o atalho dispararia DUAS vezes por toque (press +
            // release), e a caneta voltaria sozinha pro estado anterior.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if sc == SC_PEN {
                let cur = app.state::<AnnotState>().pen.load(Ordering::SeqCst);
                let _ = apply_pen(app, !cur);
            } else {
                let _ = app.emit("annot-clear", ());
            }
        })
        .map_err(|e| format!("não deu pra registrar {}: {}", sc, e))?;
    }
    Ok(())
}

fn unregister_shortcuts(app: &AppHandle) {
    let gs = app.global_shortcut();
    for sc in [SC_PEN, SC_CLEAR] {
        let _ = gs.unregister(sc);
    }
}

/// Chamado no `RunEvent::Exit`. Atalho global é recurso do SISTEMA: sair sem
/// devolver deixaria o Ctrl+Shift+D preso até o próximo boot.
pub fn release_on_exit(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_so_rouba_o_mouse_com_caneta_na_mao() {
        // O teste que protege o produto: em TODO estado que não seja
        // "armado + caneta ligada", o clique tem que atravessar pro app de
        // baixo. Um `false` a mais aqui e o usuário não consegue mais clicar
        // em nada na própria máquina enquanto grava.
        assert!(ignore_cursor(false, false), "desarmado: clique atravessa");
        assert!(ignore_cursor(false, true), "desarmado manda mais que a caneta");
        assert!(ignore_cursor(true, false), "armado sem caneta: clique atravessa");
        assert!(!ignore_cursor(true, true), "caneta na mão: o overlay recebe o mouse");
    }

    #[test]
    fn armado_sem_caneta_e_o_estado_normal() {
        // Regressão do caso de uso: o usuário arma antes da aula e SÓ usa a
        // caneta em alguns momentos. O tempo quase todo o overlay está de pé,
        // visível, e invisível pro mouse.
        assert!(ignore_cursor(true, false));
    }
}
