/**
 * Seções recolhíveis de painel — o núcleo PURO do padrão B9 da suíte.
 *
 * CÓPIA LITERAL do LocalVideo (que é o piloto do padrão), de propósito: a regra
 * de "quando uma seção nasce aberta" não pode divergir entre os apps da suíte.
 * Ao mexer aqui, mexa lá — e vice-versa.
 *
 * Aqui no LocalRecord o problema que ele resolve é o `.grid`: quem rola é o
 * workspace INTEIRO, então com os 6 cards abertos numa janela de 520px de
 * altura (o mínimo do `tauri.conf.json`) a barra de gravar sai da tela.
 *
 * ## A regra que manda: colapsar por DISCIPLINA, não por moda
 *
 * `sectionOpen` é a regra inteira em três linhas, e a ordem importa:
 *
 * 1. Se o usuário JÁ OPINOU sobre esta seção, a opinião dele manda. Sempre.
 * 2. Se ele nunca opinou e a seção tem valor NÃO-NEUTRO (`active`), ela nasce
 *    ABERTA. Um ajuste que está ligado e mudando o comportamento não pode ficar
 *    escondido: é assim que nasce o bug clássico de "o app está fazendo algo
 *    estranho e eu não sei por quê".
 * 3. Só o resto — seção em estado neutro, que não explica nada de graça —
 *    nasce fechada.
 *
 * O ponto "em uso" (`active`) é o que sustenta o passo 1 com segurança: mesmo
 * que o usuário feche uma seção que tem valor, o ponto continua visível no
 * cabeçalho fechado dizendo "tem coisa aqui dentro". Sem esse ponto, persistir
 * a escolha dele ESCONDERIA estado — e aí o passo 1 seria um erro.
 *
 * ## Por que persiste
 *
 * É layout de bancada, não "estou mexendo nisto agora": quem já configurou as
 * fontes fecha o card uma vez e não quer reabri-lo a cada gravação. Mora em
 * `localStorage`, com chave por app.
 */

/** Quais seções o usuário abriu/fechou. Ausente = "ainda não opinou". */
export type SectionState = Record<string, boolean>;

/**
 * A seção `id` deve aparecer aberta?
 *
 * `active` = a propriedade desta seção está em uso (valor ≠ do neutro). É o
 * padrão SÓ enquanto o usuário não tiver opinião própria sobre ela.
 */
export function sectionOpen(saved: SectionState, id: string, active: boolean): boolean {
  const v = saved[id];
  return typeof v === "boolean" ? v : active;
}

/**
 * Lê o estado gravado. Tolerante de propósito: chave ausente, JSON quebrado,
 * `localStorage` bloqueado (modo restrito) ou inexistente (teste em Node) — em
 * todos os casos a resposta é "ninguém opinou ainda", e o padrão do passo 2
 * volta a valer. Preferência de layout nunca pode impedir o app de abrir.
 */
export function parseSections(raw: string | null): SectionState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  // Filtra valor a valor: um `{"audio": "sim"}` gravado por uma versão futura
  // (ou por outra aba) não pode virar um `open` truthy que ninguém previu.
  const out: SectionState = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function loadSections(key: string): SectionState {
  if (typeof localStorage === "undefined") return {};
  try {
    return parseSections(localStorage.getItem(key));
  } catch {
    return {};
  }
}

export function saveSections(key: string, state: SectionState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage cheio ou bloqueado: a sessão atual segue funcionando */
  }
}

/** Aplica um toggle sobre o estado (função pura pro store chamar). */
export function toggled(state: SectionState, id: string, open: boolean): SectionState {
  return { ...state, [id]: open };
}
