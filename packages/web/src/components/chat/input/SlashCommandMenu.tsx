import { useState, useEffect, useMemo, useRef } from "react";
import type { SlashCommandEntry } from "@octopus/tentacle";

/**
 * Floating autocomplete menu for slash commands — appears above the textarea
 * when the user types `/` at the start of the input.
 *
 * Commands are split into two sections:
 *   - "工具" — built-in system commands (clear, theme, settings, …)
 *   - "自定义" — user-defined prompt-template commands
 *
 * Mouse-only interaction: hover to highlight, click to select.
 */

export interface SlashCommandMenuProps {
  commands: SlashCommandEntry[];
  query: string;
  visible: boolean;
  onSelect: (cmd: SlashCommandEntry) => void;
}

export function SlashCommandMenu({
  commands,
  query,
  visible,
  onSelect,
}: SlashCommandMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter by query, then split into system and prompt groups.
  const { systemCmds, promptCmds } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? commands.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.displayName.toLowerCase().includes(q),
        )
      : commands;
    return {
      systemCmds: filtered.filter((c) => c.kind === "system"),
      promptCmds: filtered.filter((c) => c.kind === "prompt"),
    };
  }, [commands, query]);

  // Reset highlight whenever the filtered set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, commands]);

  // Scroll active item into view.
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector("[data-active]") as HTMLElement | null;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const total = systemCmds.length + promptCmds.length;
  if (!visible || total === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "100%",
        marginBottom: 6,
        maxHeight: 320,
        overflowY: "auto",
        background: "var(--gray-0)",
        border: "1px solid var(--gray-150)",
        borderRadius: 12,
        boxShadow: "0 8px 24px var(--shadow-2), 0 2px 6px var(--shadow-1)",
        zIndex: 100,
        padding: 6,
      }}
    >
      {/* System commands section */}
      {systemCmds.length > 0 && (
        <CommandGroup
          label="工具"
          commands={systemCmds}
          activeIndex={activeIndex}
          baseIndex={0}
          onHover={setActiveIndex}
          onSelect={onSelect}
          showAction={false}
        />
      )}

      {/* Prompt commands section */}
      {promptCmds.length > 0 && (
        <>
          {systemCmds.length > 0 && (
            <div style={{ borderTop: "1px solid var(--gray-100)", margin: "4px 0" }} />
          )}
          <CommandGroup
            label="自定义"
            commands={promptCmds}
            activeIndex={activeIndex}
            baseIndex={systemCmds.length}
            onHover={setActiveIndex}
            onSelect={onSelect}
            showAction={true}
          />
        </>
      )}
    </div>
  );
}

/** Renders a group of commands with an optional section label. */
function CommandGroup({
  label,
  commands,
  activeIndex,
  baseIndex,
  onHover,
  onSelect,
  showAction,
}: {
  label: string;
  commands: SlashCommandEntry[];
  activeIndex: number;
  baseIndex: number;
  onHover: (i: number) => void;
  onSelect: (cmd: SlashCommandEntry) => void;
  showAction: boolean;
}) {
  return (
    <div>
      <div
        style={{
          padding: "5px 10px 3px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--gray-400)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      {commands.map((cmd, i) => {
        const idx = baseIndex + i;
        const isActive = idx === activeIndex;
        return (
          <div
            key={cmd.id}
            role="option"
            aria-selected={isActive}
            {...(isActive ? { "data-active": "" } : {})}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 10px",
              cursor: "pointer",
              borderRadius: 7,
              background: isActive
                ? "color-mix(in srgb, var(--main-color) 9%, var(--gray-0))"
                : "transparent",
              transition: "background-color 0.12s ease",
            }}
          >
            {/* Command name — the primary identifier */}
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: isActive ? "var(--main-color)" : "var(--gray-1000)",
                lineHeight: 1.2,
                flexShrink: 0,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              /{cmd.name}
            </span>

            {/* Description — single line, right after the command name */}
            {cmd.description && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--gray-500)",
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flexShrink: 1,
                  minWidth: 0,
                }}
              >
                {cmd.description}
              </span>
            )}

            {/* Action badge — only for prompt commands */}
            {showAction && cmd.action && (
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 4,
                  color: "var(--gray-500)",
                  background: "var(--gray-50)",
                  lineHeight: 1.4,
                }}
              >
                {cmd.action === "send" ? "发送" : "插入"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
