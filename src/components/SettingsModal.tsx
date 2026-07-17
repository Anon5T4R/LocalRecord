import { LOCALE_LABELS, setLocale, t, useLocale, type Locale } from "../lib/i18n";
import { useUi, type Theme } from "../state/ui";

/** Configurações: tema e idioma (padrão da suíte). */
export default function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const locale = useLocale();

  if (!open) return null;

  // Montado na função (não em const de módulo): senão os rótulos ficam stale
  // quando o idioma troca — gotcha pago na suíte.
  const themes: { value: Theme; label: string }[] = [
    { value: "system", label: t("settings.themeSystem") },
    { value: "light", label: t("settings.themeLight") },
    { value: "dark", label: t("settings.themeDark") },
    { value: "nature", label: t("settings.themeNature") },
    { value: "darkblue", label: t("settings.themeDarkBlue") },
    { value: "calmgreen", label: t("settings.themeCalmGreen") },
    { value: "pastelpink", label: t("settings.themePastelPink") },
    { value: "punkprincess", label: t("settings.themePunkPrincess") },
  ];

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("settings.title")}</h2>

        <div className="settings-row">
          <span>{t("settings.theme")}</span>
          <div className="segmented">
            {themes.map((th) => (
              <button
                key={th.value}
                className={theme === th.value ? "active" : ""}
                onClick={() => setTheme(th.value)}
              >
                {th.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span>{t("settings.language")}</span>
          <div className="segmented">
            {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
              <button key={l} className={locale === l ? "active" : ""} onClick={() => setLocale(l)}>
                {LOCALE_LABELS[l]}
              </button>
            ))}
          </div>
        </div>

        <p className="muted about">
          <strong>LocalRecord</strong>
          {t("settings.about")}
        </p>

        <div className="modal-actions">
          <button className="primary" onClick={() => setOpen(false)}>
            {t("dlg.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
