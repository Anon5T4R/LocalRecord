import { meterDb, meterPct } from "../lib/sources";

/**
 * Medidor de nível (VU) de uma fonte de áudio.
 *
 * Existe pra responder ANTES de gravar a única pergunta que importa: "o som
 * está entrando?". Sem ele, o usuário só descobre que o take saiu mudo depois
 * de gravar 40 minutos — e aí não tem conserto. Por isso ele é uma barra
 * mexendo, não um texto: silêncio e som têm que ser distinguíveis de relance.
 *
 * O pico vem do Rust (cpal) pelo evento `audio-level`; aqui só se desenha.
 */
export default function AudioMeter(props: { peak: number; error?: string | null; hint?: string }) {
  const { peak, error, hint } = props;
  if (error) {
    // Sem medidor a gente DIZ que não tem medidor. A barra parada em zero seria
    // indistinguível de "não está entrando som" — mentira por omissão.
    return <p className="muted small meter-msg">{error}</p>;
  }
  const pct = meterPct(peak);
  return (
    <div className="meter-row">
      <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        {/* `hot`: acima de -6 dB o áudio está perto de estourar. A cor é aviso,
            não enfeite — clipping não se conserta na edição. */}
        <div className={`meter-fill${pct > 90 ? " hot" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="muted small meter-db">{meterDb(peak)}</span>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}
