import type { AgentQuestion, AnswerQuestionInput } from "@kalki/contracts";
import { Check, CircleAlert, LoaderCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { label } from "../../lib/format.js";

export function QuestionPrompt({
  question,
  busy,
  onAnswer,
}: {
  question: AgentQuestion;
  busy: boolean;
  onAnswer: (
    answer: string,
    decision: AnswerQuestionInput["decision"],
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<{
    answer: string;
    decision: AnswerQuestionInput["decision"];
  } | null>(null);
  const [custom, setCustom] = useState("");
  const allowsCustom = question.gate_kind === "clarification";
  const reviewDecisions: AnswerQuestionInput["decision"][] = [
    "approve",
    "revise",
    "cancel",
  ];
  const choices = question.options.map((answer, index) => {
    const decision = allowsCustom
      ? "free_text"
      : (reviewDecisions[index] ?? "revise");
    return {
      answer,
      decision,
      disabled:
        question.gate_kind === "production_review" &&
        !question.run_id &&
        decision === "approve",
    };
  });
  const answer = custom.trim() || selected?.answer || "";
  const decision = custom.trim() ? "free_text" : selected?.decision;

  useEffect(() => {
    setSelected(null);
    setCustom("");
  }, [question.id]);

  return (
    <section className="question-prompt">
      <div className="question-prompt__header">
        <CircleAlert size={17} />
        <span>{label(question.gate_kind)}</span>
      </div>
      <p>{question.question_text}</p>
      {question.options.length ? (
        <div className="question-options">
          {choices.map((choice) => (
            <button
              key={choice.answer}
              type="button"
              className={
                selected?.answer === choice.answer
                  ? "question-option question-option--selected"
                  : "question-option"
              }
              onClick={() => {
                setSelected(choice);
                setCustom("");
              }}
              disabled={busy || choice.disabled}
              title={
                choice.disabled
                  ? "Create the production run before approving it"
                  : undefined
              }
            >
              <span className="question-option__radio">
                {selected?.answer === choice.answer ? (
                  <Check size={12} />
                ) : null}
              </span>
              {choice.answer}
            </button>
          ))}
        </div>
      ) : null}
      {allowsCustom ? (
        <textarea
          name="answer"
          rows={2}
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            setSelected(null);
          }}
          placeholder="Type your answer"
          disabled={busy}
        />
      ) : null}
      <button
        className="button button--primary button--small"
        type="button"
        disabled={busy || !answer || !decision}
        onClick={() => decision && onAnswer(answer, decision)}
      >
        {busy ? (
          <LoaderCircle className="spin" size={15} />
        ) : (
          <Send size={15} />
        )}
        Submit answer
      </button>
    </section>
  );
}
