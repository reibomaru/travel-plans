import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export type AdminSelectOption<T extends string> = { value: T; label: string; icon?: ReactNode };

/**
 * 管理ダッシュボードの選択 UI（絞り込み・ロール変更）。
 * ネイティブ <select> は OS 依存で見た目が崩れるため、自前のドロップダウンにしている
 * （spotChat/SessionSelect と同じ方針）。
 */
export default function AdminSelect<T extends string>({
  value,
  options,
  onSelect,
  title,
  disabled = false,
  align = "left",
  className = "",
}: {
  value: T;
  options: AdminSelectOption<T>[];
  onSelect: (value: T) => void;
  title?: string;
  disabled?: boolean;
  /** メニューの寄せ方向（右端に置くボタンでは "right"）。 */
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:border-slate-300 focus:border-cyan-500 focus:outline-none disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-500"
      >
        {current?.icon}
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? ""}</span>
        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          className={`absolute top-full z-30 mt-1 min-w-full whitespace-nowrap rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800 dark:shadow-none dark:ring-1 dark:ring-white/10 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onSelect(o.value);
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-cyan-50 dark:hover:bg-cyan-500/10 ${
                    selected ? "text-cyan-800 dark:text-cyan-300" : "text-slate-700 dark:text-slate-200"
                  }`}
                >
                  <Check size={13} className={`shrink-0 ${selected ? "text-cyan-600 dark:text-cyan-400" : "text-transparent"}`} />
                  {o.icon}
                  <span className="min-w-0 flex-1">{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
