import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Validate that answers match question IDs and valid option values.
 */
export function validateAnswers(answers) {
  const dataPath = join(__dirname, "..", "..", "data", "questions.json");
  const data = JSON.parse(readFileSync(dataPath, "utf-8"));
  const questionIds = new Set(data.questions.map((q) => q.id));
  const validOptionsByQuestion = new Map(
    data.questions.map((q) => [
      q.id,
      new Set(q.options.map((o) => o.value)),
    ])
  );

  const errors = [];

  for (const [qId, value] of Object.entries(answers)) {
    if (!questionIds.has(qId)) {
      errors.push(`Unknown question ID: ${qId}`);
      continue;
    }
    const validOptions = validOptionsByQuestion.get(qId);
    if (!validOptions?.has(value)) {
      errors.push(`Invalid option "${value}" for question ${qId}`);
    }
  }

  const missing = data.questions
    .filter((q) => !(q.id in answers))
    .map((q) => q.id);
  if (missing.length > 0) {
    errors.push(`Missing answers for: ${missing.join(", ")}`);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      message: `Validation failed: ${errors.join("; ")}`,
    };
  }

  return {
    valid: true,
    message:
      "All answers recorded. You can now call `show_results` to see your flower match!",
    answers,
  };
}
