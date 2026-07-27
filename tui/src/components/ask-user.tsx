// =============================================================================
// Ask-user interaction widget — handles agent questions during execution.
// Equivalent to Python tui.widgets.ask_user.AskUserMenu.
//
// Supports text input and multiple-choice questions, with an "Other" free-form
// option always available for multiple choice.
// =============================================================================

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";
import type { Question, AskUserWidgetResult } from "../types.js";

// =============================================================================
// Props
// =============================================================================

export interface AskUserMenuProps {
  /** Questions to present. */
  questions: Question[];
  /** Resolve with the user's answers. */
  onAnswer: (result: AskUserWidgetResult) => void;
}

// =============================================================================
// Internal per-question state
// =============================================================================

interface QuestionState {
  answer: string;
  choiceIdx: number;
  showOtherInput: boolean;
  submitted: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const AskUserMenu: React.FC<AskUserMenuProps> = ({ questions, onAnswer }) => {
  const glyphs = getGlyphs();
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [states, setStates] = useState<QuestionState[]>(() =>
    questions.map(() => ({
      answer: "",
      choiceIdx: 0,
      showOtherInput: false,
      submitted: false,
    }))
  );

  const question = questions[currentQuestion];
  if (!question) return null;

  const state = states[currentQuestion];
  const isMultipleChoice = question.type === "multiple_choice";
  const choices = isMultipleChoice
    ? [...(question.choices ?? []).map((c) => c.value), "Other (free-form)"]
    : [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const updateState = useCallback((updates: Partial<QuestionState>) => {
    setStates((prev) => {
      const next = [...prev];
      next[currentQuestion] = { ...next[currentQuestion], ...updates };
      return next;
    });
  }, [currentQuestion]);

  const submitCurrent = useCallback(() => {
    if (isMultipleChoice && state.choiceIdx === choices.length - 1) {
      // "Other" selected — show input
      updateState({ showOtherInput: true });
      return;
    }

    // Mark as submitted
    updateState({ submitted: true });

    // Auto-advance if there are more questions
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
    } else {
      // All done — collect answers and submit
      const answers = states.map((s, i) => {
        if (i === currentQuestion) {
          return isMultipleChoice ? choices[state.choiceIdx] : state.answer;
        }
        return s.answer;
      });
      onAnswer({ type: "answered", answers });
    }
  }, [currentQuestion, isMultipleChoice, state, states, choices, questions.length, onAnswer, updateState]);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      onAnswer({ type: "cancelled" });
      return;
    }

    // Tab — next question
    if (key.tab && !state.showOtherInput) {
      updateState({ submitted: true });
      if (currentQuestion < questions.length - 1) {
        setCurrentQuestion(currentQuestion + 1);
      }
      return;
    }

    if (state.showOtherInput) {
      // Free-form text input mode
      if (key.return) {
        const currentAnswer = state.answer;
        updateState({ submitted: true });
        if (currentQuestion < questions.length - 1) {
          setCurrentQuestion(currentQuestion + 1);
        } else {
          const answers = states.map((s, i) => {
            if (i === currentQuestion) return currentAnswer;
            return s.answer;
          });
          onAnswer({ type: "answered", answers });
        }
        return;
      }
      if (key.backspace || key.delete) {
        updateState({ answer: state.answer.slice(0, -1) });
        return;
      }
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        updateState({ answer: state.answer + input });
        return;
      }
      return;
    }

    if (isMultipleChoice) {
      // Multiple choice navigation
      if (key.upArrow) {
        updateState({ choiceIdx: state.choiceIdx <= 0 ? choices.length - 1 : state.choiceIdx - 1 });
        return;
      }
      if (key.downArrow || key.tab) {
        updateState({ choiceIdx: state.choiceIdx >= choices.length - 1 ? 0 : state.choiceIdx + 1 });
        return;
      }
      if (key.return) {
        if (state.choiceIdx === choices.length - 1) {
          updateState({ showOtherInput: true });
        } else {
          updateState({
            answer: choices[state.choiceIdx],
            submitted: true,
          });
          submitCurrent();
        }
        return;
      }
    } else {
      // Text input mode
      if (key.return) {
        if (state.answer.trim() || !question.required) {
          submitCurrent();
        }
        return;
      }
      if (key.backspace || key.delete) {
        updateState({ answer: state.answer.slice(0, -1) });
        return;
      }
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        updateState({ answer: state.answer + input });
        return;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {glyphs.bullet} Agent Question {currentQuestion + 1} of {questions.length}
        </Text>
      </Box>

      {/* Question text */}
      <Box marginBottom={1}>
        <Text>{question.question}</Text>
        {question.required !== false && (
          <Text color="red"> *</Text>
        )}
      </Box>

      {/* Progress indicator */}
      <Box marginBottom={1}>
        <Text dimColor>
          {questions.map((_, i) =>
            i === currentQuestion
              ? `${glyphs.arrow} `
              : states[i]?.submitted
              ? `${glyphs.checkmark} `
              : `${i + 1} `
          ).join("")}
        </Text>
      </Box>

      {/* Choices (multiple choice) */}
      {isMultipleChoice && !state.showOtherInput && (
        <Box flexDirection="column" marginBottom={1}>
          {choices.map((choice, i) => {
            const isSelected = i === state.choiceIdx;
            return (
              <Box key={i}>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? `${glyphs.arrow} ` : "  "}
                  {choice}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Text input or "Other" input */}
      {(!isMultipleChoice || state.showOtherInput) && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="cyan">{glyphs.arrow} </Text>
            <Text>{state.answer}</Text>
            <Text dimColor>█</Text>
          </Box>
        </Box>
      )}

      {/* Hint */}
      <Box>
        <Text dimColor>
          {isMultipleChoice
            ? `${glyphs.bullet} ↑↓ to choose, Enter to select, Tab for next, Esc to cancel`
            : `${glyphs.bullet} Type your answer, Enter to submit, Esc to cancel`}
        </Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// Ask-user promise helper
// =============================================================================

export function createAskUserPromise(): {
  promise: Promise<AskUserWidgetResult>;
  resolve: (result: AskUserWidgetResult) => void;
} {
  let resolveFn!: (result: AskUserWidgetResult) => void;
  const promise = new Promise<AskUserWidgetResult>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}
