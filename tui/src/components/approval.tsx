// =============================================================================
// HITL approval menu — presents tool approval options to the user.
// Equivalent to Python tui.widgets.approval.ApprovalMenu.
//
// Uses a Promise-based blocking pattern (equivalent to Python's asyncio.Future):
// the caller creates a promise that resolves when the user makes a decision.
// =============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";
import type { ToolRenderer } from "./tool-renderers.js";
import { getRenderer } from "./tool-renderers.js";
import { detectDangerousUnicode, summarizeIssues, checkUrlSafety } from "@octopus/core";

// =============================================================================
// Types
// =============================================================================

export type ApprovalDecision = "approve" | "reject" | "auto_approve";

export interface ApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** Whether this is a batch request (multiple tools). */
  isBatch?: boolean;
  batchSize?: number;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  /** Optional reason for rejection. */
  reason?: string;
}

// =============================================================================
// Props
// =============================================================================

export interface ApprovalMenuProps {
  /** The tool(s) awaiting approval. */
  requests: ApprovalRequest[];
  /** Resolve with the user's decision. */
  onDecide: (result: ApprovalResult) => void;
  /** Current auto-approve state. */
  autoApprove: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const ApprovalMenu: React.FC<ApprovalMenuProps> = ({
  requests,
  onDecide,
  autoApprove,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const options = [
    { key: "y", label: "Approve", decision: "approve" as const },
    { key: "a", label: "Auto-approve", decision: "auto_approve" as const },
    { key: "n", label: "Reject (with reason)", decision: "reject" as const },
  ];

  // Collect security warnings
  const securityWarnings = collectWarnings(requests);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (showRejectInput) {
      // Reject reason input mode
      if (key.return) {
        onDecide({ decision: "reject", reason: rejectReason || undefined });
        return;
      }
      if (key.escape) {
        setShowRejectInput(false);
        setRejectReason("");
        return;
      }
      if (key.backspace || key.delete) {
        setRejectReason((prev) => prev.slice(0, -1));
        return;
      }
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        setRejectReason((prev) => prev + input);
      }
      return;
    }

    // Navigation
    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? options.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= options.length - 1 ? 0 : prev + 1));
      return;
    }

    // Selection
    if (key.return) {
      const selected = options[selectedIdx];
      if (selected) {
        if (selected.decision === "reject") {
          // Show reject reason input
          setShowRejectInput(true);
        } else {
          onDecide({ decision: selected.decision });
        }
      }
      return;
    }

    // Quick keys
    if (input === "y" || input === "Y") {
      onDecide({ decision: "approve" });
      return;
    }
    if (input === "a" || input === "A") {
      onDecide({ decision: "auto_approve" });
      return;
    }
    if (input === "n" || input === "N") {
      setShowRejectInput(true);
      return;
    }

    // Number keys
    if (input === "1") { onDecide({ decision: "approve" }); return; }
    if (input === "2") { onDecide({ decision: "auto_approve" }); return; }
    if (input === "3") { setShowRejectInput(true); return; }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const request = requests[0];
  if (!request) return null;

  // Get tool-specific renderer
  const renderer = getRenderer(request.toolName);
  const rendered = renderer ? renderer.render(request.args) : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="yellow">
          {glyphs.toolCall} Approve: <Text color="yellow">{request.toolName}</Text>
        </Text>
        {requests.length > 1 && (
          <Text dimColor> ({requests.length} tools)</Text>
        )}
      </Box>

      {/* Tool info */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Tool: </Text>
          <Text color="yellow">{request.toolName}</Text>
        </Text>

        {/* Rendered tool preview */}
        {rendered && (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {rendered.title && <Text bold>{rendered.title}</Text>}
            {rendered.details && rendered.details.map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
            {rendered.code && (
              <Box flexDirection="column" paddingLeft={2}>
                {rendered.code.split("\n").slice(0, 15).map((line, i) => (
                  <Text key={i} dimColor>{line}</Text>
                ))}
                {rendered.code.split("\n").length > 15 && (
                  <Text dimColor>{glyphs.ellipsis}</Text>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Generic args display (fallback) */}
        {!rendered && (
          <Box flexDirection="column" paddingLeft={2} marginTop={1}>
            {Object.entries(request.args).slice(0, 10).map(([key, value]) => (
              <Text key={key} dimColor>
                {key}: {formatArgValue(value)}
              </Text>
            ))}
          </Box>
        )}
      </Box>

      {/* Security warnings */}
      {securityWarnings.length > 0 && (
        <Box flexDirection="column" marginBottom={1} borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red" bold>{glyphs.cross} Security Warning:</Text>
          {securityWarnings.map((warning, i) => (
            <Text key={i} color="red">{warning}</Text>
          ))}
        </Box>
      )}

      {/* Reject reason input */}
      {showRejectInput ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text>Reason for rejection (optional, Enter to confirm, Esc to cancel):</Text>
          <Box>
            <Text color="red">{glyphs.arrow} </Text>
            <Text>{rejectReason}</Text>
            <Text dimColor>█</Text>
          </Box>
        </Box>
      ) : (
        <>
          {/* Options */}
          <Box flexDirection="column" marginBottom={1}>
            {options.map((opt, i) => {
              const isSelected = i === selectedIdx;
              return (
                <Box key={opt.key}>
                  <Text color={isSelected ? "yellow" : undefined} bold={isSelected}>
                    {isSelected ? `${glyphs.arrow} ` : "  "}
                    [{opt.key}] {opt.label}
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* Hint */}
          <Box>
            <Text dimColor>
              ↑↓ navigate  ·  Enter select  ·  y/a/n quick keys
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
};

// =============================================================================
// Warning collection — equivalent to Python approval.py security checks
// =============================================================================

function collectWarnings(requests: ApprovalRequest[]): string[] {
  const warnings: string[] = [];

  for (const request of requests) {
    // Check for dangerous unicode in args
    for (const value of Object.values(request.args)) {
      if (typeof value === "string") {
        try {
          const issues = detectDangerousUnicode(value);
          if (issues.length > 0) {
            warnings.push(...summarizeIssues(issues));
          }
        } catch {
          // unicode_security functions might not exist yet
        }
      }
    }

    // URL safety check for web_search / fetch_url
    if (request.toolName === "fetch_url" || request.toolName === "web_search") {
      const url = request.args.url as string;
      if (url && typeof url === "string") {
        try {
          checkUrlSafety(url);
        } catch {
          warnings.push(`Suspicious URL detected: ${url.slice(0, 80)}`);
        }
      }
    }
  }

  return warnings;
}

// =============================================================================
// Helpers
// =============================================================================

function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 200 ? value.slice(0, 200) + "..." : value;
  }
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? s.slice(0, 200) + "..." : s;
  } catch {
    return String(value).slice(0, 200);
  }
}

// =============================================================================
// Approval promise helper — creates a promise that resolves when user decides
// Equivalent to Python's asyncio.Future pattern
// =============================================================================

export function createApprovalPromise(): {
  promise: Promise<ApprovalResult>;
  resolve: (result: ApprovalResult) => void;
} {
  let resolveFn!: (result: ApprovalResult) => void;
  const promise = new Promise<ApprovalResult>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}
