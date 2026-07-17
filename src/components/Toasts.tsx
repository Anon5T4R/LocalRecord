import { useEffect } from "react";
import { useUi } from "../state/ui";

/** Toasts empilhados no canto (somem sozinhos em 4s). */
export default function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const id = toasts[0].id;
    const timer = setTimeout(() => dismiss(id), 4000);
    return () => clearTimeout(timer);
  }, [toasts, dismiss]);

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismiss(toast.id)}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
