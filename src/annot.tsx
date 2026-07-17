import React from "react";
import ReactDOM from "react-dom/client";
import AnnotOverlay from "./components/AnnotOverlay";
import "./annot.css";
import { useLocale } from "./lib/i18n";

// Entrada da janela `annot` — separada da `main` de propósito. O overlay não
// carrega o App inteiro (fontes, prévia, zustand da UI): ele fica de pé por
// horas em cima da tela durante uma aula, e o que ele NÃO carrega é o que ele
// não gasta. `applyTheme` também não vem: a barrinha tem paleta própria e fixa
// (annot.css explica por quê), e mexer no <html> aqui só arriscaria pintar
// fundo numa janela que precisa ser transparente.

function Root() {
  const locale = useLocale();
  return <AnnotOverlay key={locale} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
