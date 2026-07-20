import { useId, type ReactNode } from "react";

import { t } from "../lib/i18n";

/**
 * Seção recolhível de painel — o componente do padrão B9 da suíte.
 *
 * Anda em par com `lib/sections.ts` (a regra pura de abrir/fechar e a
 * persistência). Este arquivo é a metade que sabe de DOM; a outra é a que sabe
 * decidir. Os dois vão copiados juntos pros outros apps.
 *
 * ## Acessibilidade não é opcional (e é onde o piloto estava incompleto)
 *
 * - O cabeçalho é um `<button type="button">` DE VERDADE, não um `<div
 *   onClick>`. Sai de graça: foco por Tab, Enter e Espaço, papel anunciado. Um
 *   `div` clicável simplesmente não existe pra quem navega por teclado.
 *   O `type="button"` não é firula — dentro de um `<form>` um `<button>` sem
 *   tipo SUBMETE o formulário ao ser acionado.
 * - `aria-expanded` diz o estado, e `aria-controls` diz o que ele controla.
 *   Por isso o corpo é renderizado SEMPRE (com `hidden` quando fechado): um
 *   `aria-controls` apontando pra um id que não existe no DOM não ajuda
 *   ninguém. Os filhos, esses sim, só montam quando abre.
 * - **O ponto "em uso" tem texto pra quem não vê o ponto.** No piloto ele era
 *   `aria-hidden`, ou seja: a informação "esta seção tem valor não-neutro" —
 *   justamente a que a regra do B9 existe pra não esconder — estava escondida
 *   de quem usa leitor de tela. Agora vai um rótulo textual junto.
 */
export function Section({
  id,
  title,
  open,
  onToggle,
  active,
  summary,
  children,
}: {
  /** Identidade estável da seção (é a chave no estado persistido). */
  id: string;
  title: string;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  /** A propriedade desta seção está em uso? (nasce aberta e ganha o ponto) */
  active?: boolean;
  /** Valor resumido à direita do título, pra ler SEM abrir (ex.: "1×"). */
  summary?: string;
  children: ReactNode;
}) {
  // `useId` e não o `id` da seção: o id da seção é livre pra ser curto ("audio")
  // e dois painéis na mesma tela poderiam repeti-lo. Id duplicado quebra
  // justamente o `aria-controls`.
  const bodyId = `sec-body-${useId()}`;
  return (
    <div className={`insp-sec ${open ? "open" : ""}`}>
      <button
        type="button"
        className="insp-sec-head"
        onClick={() => onToggle(id, !open)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="insp-chevron" aria-hidden>
          ▸
        </span>
        <span className="insp-sec-title">{title}</span>
        {active ? (
          <>
            <span className="insp-dot" aria-hidden />
            <span className="sr-only">{t("sec.inUse")}</span>
          </>
        ) : null}
        {summary ? <span className="muted small tabnum">{summary}</span> : null}
      </button>
      <div id={bodyId} className="insp-sec-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
