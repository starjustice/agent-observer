"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { StoredEvent } from "@ao/shared";

/** How a piece of event text is introduced, so prompts, commands and delegations read differently. */
function lead(event: StoredEvent): { tag: string | null; prefix: string } {
  if (event.eventType === "prompt_submitted") return { tag: "You", prefix: "" };
  if (event.toolName === "Bash" || event.toolName === "PowerShell") return { tag: null, prefix: "$ " };
  if (event.toolName === "Agent" || event.toolName === "Task") return { tag: null, prefix: "→ " };
  return { tag: null, prefix: "" };
}

/**
 * What the agent was asked to do: the prompt, shell command, search or subagent
 * task behind an event. Two lines until clicked.
 */
export function EventText({ event, compact = false }: { event: StoredEvent; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = event.text;
  if (!text) return null;
  const { tag, prefix } = lead(event);
  const long = text.length > 120 || text.includes("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the text is still selectable.
    }
  };

  return (
    <div className="mt-1 flex items-start gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={long ? open : undefined}
        disabled={!long}
        title={long ? (open ? "Show less" : "Show all") : undefined}
        className={`min-w-0 flex-1 rounded-md bg-muted/50 px-2 py-1 text-left font-mono ${
          compact ? "text-[11px]" : "text-xs"
        } text-foreground/85 ${long ? "cursor-pointer hover:bg-muted" : "cursor-default"} ${
          open ? "whitespace-pre-wrap break-words" : "line-clamp-2 break-words"
        }`}
      >
        {tag ? (
          <span className="mr-1.5 rounded bg-violet/20 px-1 font-sans text-[10px] font-semibold text-violet">
            {tag}
          </span>
        ) : null}
        <span className="text-muted-foreground">{prefix}</span>
        {event.eventType === "prompt_submitted" ? `“${text}”` : text}
      </button>
      {open ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy text"}
          className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}
