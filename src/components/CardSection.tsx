import { type ReactNode } from "react";

import { sectionOpen } from "../lib/sections";
import { useUi } from "../state/ui";
import { Section } from "./Section";

/**
 * Um `card` do LocalRecord que recolhe — o adaptador entre o `Section`
 * genérico (padrão B9 da suíte) e o store deste app.
 *
 * O `Section` é burro de propósito: recebe `open`/`onToggle` e não conhece
 * store nenhum. É o que permite que ele seja **cópia literal** do LocalVideo,
 * que é o piloto do padrão. Quem casa o padrão com o app é este wrapper.
 *
 * ## O que teve que mudar no JSX pra isto caber (vale pros próximos portes)
 *
 * O `.card-head` daqui tinha um ACESSÓRIO ao lado do título: o botão
 * "Atualizar" nas Fontes, o encoder na Saída, o LED na Anotação. Um `<button>`
 * dentro de um `<button>` é HTML inválido e o navegador desmonta — então o
 * cabeçalho não podia simplesmente virar botão com o que já estava dentro.
 *
 * A saída não foi inventar um slot novo: foi perceber que os acessórios já
 * cabiam no que o padrão oferece.
 * - O encoder e o estado da anotação viraram `summary` — que existe exatamente
 *   pra "ler sem abrir", e agora funciona também com o card FECHADO (antes o
 *   encoder sumia junto com o resto).
 * - O botão "Atualizar" desceu pro corpo do card. Botão em cabeçalho recolhido
 *   é botão que some; e recarregar a lista de fontes só faz sentido quando se
 *   está OLHANDO a lista.
 */
export function CardSection(props: {
  id: string;
  title: string;
  active?: boolean;
  summary?: string;
  children: ReactNode;
}) {
  const sections = useUi((s) => s.sections);
  const toggleSection = useUi((s) => s.toggleSection);
  return (
    <div className="card">
      <Section
        {...props}
        open={sectionOpen(sections, props.id, !!props.active)}
        onToggle={toggleSection}
      />
    </div>
  );
}
