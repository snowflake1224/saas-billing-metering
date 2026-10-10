"use client";

import { KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy, X } from "lucide-react";

export type Option<T extends string = string> = { value: T; label: string; hint?: string; disabled?: boolean };

export function Select<T extends string>({ label, value, options, onChange, disabled, className = "", size = "md", placeholder = "Select…" }: {
  label: string;
  value: T | "";
  options: Array<Option<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    list.current?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function show() {
    if (disabled || !options.length) return;
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (option.value !== value) onChange(option.value);
  }

  function move(step: number) {
    setActive((current) => {
      let next = current;
      for (let i = 0; i < options.length; i++) {
        next = (next + step + options.length) % options.length;
        if (!options[next].disabled) return next;
      }
      return current;
    });
  }

  function onButtonKey(event: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); }
  }

  function onListKey(event: KeyboardEvent) {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: () => { setOpen(false); button.current?.focus(); },
      Tab: () => setOpen(false),
    };
    const handler = keys[event.key];
    if (!handler) return;
    if (event.key !== "Tab") event.preventDefault();
    handler();
  }

  const padding = size === "sm" ? "px-3 py-2 text-xs" : "px-3 py-2.5 text-sm";
  return <div ref={root} className={`relative ${className}`}>
    <button ref={button} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onButtonKey}
      className={`flex w-full items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#0d1424] text-left text-slate-100 transition hover:border-blue-400/40 disabled:opacity-50 ${padding} ${open ? "border-blue-400/60" : ""}`}>
      <span className="truncate">{selected?.label ?? placeholder}</span>
      <ChevronDown size={15} className={`shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}/>
    </button>
    {open && <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey}
      className="absolute left-0 right-0 z-50 mt-1.5 max-h-64 min-w-[10rem] overflow-auto rounded-xl border border-white/10 bg-[#0d1424]/98 p-1 shadow-2xl shadow-black/60 backdrop-blur-xl">
      {options.map((option, index) => {
        const isSelected = option.value === value;
        return <li key={option.value} id={`${id}-${index}`} data-index={index} role="option" aria-selected={isSelected} aria-disabled={option.disabled}
          onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}
          className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${option.disabled ? "cursor-not-allowed opacity-40" : ""} ${index === active ? "bg-blue-500/15 text-white" : "text-slate-300"} ${isSelected ? "text-blue-200" : ""}`}>
          <span className="min-w-0"><span className="block truncate">{option.label}</span>{option.hint && <span className="block truncate text-[11px] text-slate-500">{option.hint}</span>}</span>
          {isSelected && <Check size={14} className="shrink-0 text-blue-300"/>}
        </li>;
      })}
    </ul>}
  </div>;
}

export function Card({ title, subtitle, icon, actions, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <article className={`glass min-w-0 rounded-2xl p-5 ${className}`}>
    {(title || actions) && <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {title && <h2 className="m-0 flex items-center gap-2 text-base font-semibold">{icon}{title}</h2>}
        {subtitle && <p className="m-0 mt-1 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>}
    {children}
  </article>;
}

export function Sparkline({ values, color = "#60a5fa", height = 36, className = "" }: { values: number[]; color?: string; height?: number; className?: string }) {
  const gradient = useId();
  if (values.length < 2) return <div style={{ height }} className={className}/>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${100 - ((value - min) / span) * 92 - 4}`);
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className={`w-full ${className}`} aria-hidden="true">
    <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".35"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
    <polygon points={`0,100 ${points.join(" ")} 100,100`} fill={`url(#${gradient})`}/>
    <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex justify-end">
    <button aria-label="Close panel" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose}/>
    <aside role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"} className="relative h-full w-full max-w-xl overflow-auto border-l border-white/10 bg-[#0a101c] p-6 shadow-2xl">
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="m-0 text-lg">{title}</h2><button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"><X size={18}/></button></div>
      {children}
    </aside>
  </div>;
}

export function JsonView({ value, className = "" }: { value: unknown; className?: string }) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  const html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, (match, str, colon, literal) => {
      if (str) return colon ? `<span class="text-sky-300">${str}</span>${colon}` : `<span class="text-emerald-300">${str}</span>`;
      if (literal) return `<span class="text-fuchsia-300">${match}</span>`;
      return `<span class="text-amber-300">${match}</span>`;
    });
  return <pre className={`code overflow-auto rounded-xl border border-white/8 bg-black/40 p-4 text-xs leading-relaxed text-slate-300 ${className}`} dangerouslySetInnerHTML={{ __html: html }}/>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:border-blue-400/40 hover:text-white">
    {copied ? <Check size={13}/> : <Copy size={13}/>}{copied ? "Copied" : label}
  </button>;
}

export function Badge({ tone = "slate", children }: { tone?: "slate" | "blue" | "green" | "amber" | "red" | "cyan" | "violet"; children: ReactNode }) {
  const tones = {
    slate: "bg-white/5 text-slate-300 border-white/10",
    blue: "bg-blue-500/10 text-blue-300 border-blue-400/20",
    green: "bg-emerald-500/10 text-emerald-300 border-emerald-400/20",
    amber: "bg-amber-500/10 text-amber-300 border-amber-400/20",
    red: "bg-red-500/10 text-red-300 border-red-400/20",
    cyan: "bg-cyan-500/10 text-cyan-300 border-cyan-400/20",
    violet: "bg-violet-500/10 text-violet-300 border-violet-400/20",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function LivePulse({ label = "Live", stale = false }: { label?: string; stale?: boolean }) {
  return <span className={`inline-flex items-center gap-2 text-[11px] font-semibold tracking-wider ${stale ? "text-slate-500" : "text-emerald-300"}`}>
    <span className="relative flex h-2 w-2">{!stale && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"/>}<span className={`relative inline-flex h-2 w-2 rounded-full ${stale ? "bg-slate-500" : "bg-emerald-400"}`}/></span>
    {label.toUpperCase()}
  </span>;
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<Option<T>>; onChange: (value: T) => void }) {
  return <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-white/10 bg-[#0d1424] p-0.5">
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${value === option.value ? "bg-blue-500/20 text-blue-200" : "text-slate-400 hover:text-white"}`}>{option.label}</button>)}
  </div>;
}

export function Stat({ label, value, hint, tone = "text-white" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return <div className="min-w-0"><div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div><div className={`mt-1 truncate text-lg font-semibold tabular-nums ${tone}`}>{value}</div>{hint && <div className="text-[11px] text-slate-500">{hint}</div>}</div>;
}
