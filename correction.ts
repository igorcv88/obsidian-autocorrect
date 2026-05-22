export interface EditableLine {
	prefix: string;
	body: string;
}

export interface CorrectionDecision {
	shouldCorrect: boolean;
	reason?: string;
	editable: EditableLine;
}

export interface CorrectionValidation {
	accepted: boolean;
	corrected?: string;
	reason?: string;
}

const DEFAULT_MIN_LETTERS = 3;
const MAX_LENGTH_MULTIPLIER = 2.5;
const MAX_LENGTH_SLACK = 24;

export function splitEditableLine(line: string): EditableLine {
	const leadingWhitespace = line.match(/^[\t ]*/)?.[0] ?? "";
	const withoutIndent = line.slice(leadingWhitespace.length);

	const checkboxMatch = withoutIndent.match(/^([-*+]\s+\[[ xX]\]\s+)(.*)$/);
	if (checkboxMatch) {
		return {
			prefix: leadingWhitespace + checkboxMatch[1],
			body: checkboxMatch[2],
		};
	}

	const bulletMatch = withoutIndent.match(/^([-*+]\s+)(.*)$/);
	if (bulletMatch) {
		return {
			prefix: leadingWhitespace + bulletMatch[1],
			body: bulletMatch[2],
		};
	}

	const orderedMatch = withoutIndent.match(/^(\d+[.)]\s+)(.*)$/);
	if (orderedMatch) {
		return {
			prefix: leadingWhitespace + orderedMatch[1],
			body: orderedMatch[2],
		};
	}

	const headingMatch = withoutIndent.match(/^(#{1,6}\s+)(.*)$/);
	if (headingMatch) {
		return {
			prefix: leadingWhitespace + headingMatch[1],
			body: headingMatch[2],
		};
	}

	const quoteMatch = withoutIndent.match(/^(>\s+)(.*)$/);
	if (quoteMatch) {
		return {
			prefix: leadingWhitespace + quoteMatch[1],
			body: quoteMatch[2],
		};
	}

	return {
		prefix: leadingWhitespace,
		body: withoutIndent,
	};
}

export function shouldCorrectLine(line: string): CorrectionDecision {
	const editable = splitEditableLine(line);
	const body = editable.body.trim();

	if (!body) {
		return { shouldCorrect: false, reason: "empty", editable };
	}

	if (isProtectedMarkdownLine(line)) {
		return { shouldCorrect: false, reason: "protected-markdown", editable };
	}

	if (countLetters(body) < DEFAULT_MIN_LETTERS) {
		return { shouldCorrect: false, reason: "not-enough-letters", editable };
	}

	if (!/\p{L}/u.test(body)) {
		return { shouldCorrect: false, reason: "no-letters", editable };
	}

	if (isLikelyUrlOrEmail(body)) {
		return { shouldCorrect: false, reason: "url-or-email", editable };
	}

	return { shouldCorrect: true, editable };
}

export function buildCorrectionPrompt(text: string): string {
	return [
		"You are an autocorrect engine for a Markdown note editor.",
		"Correct only clear spelling mistakes in the input text.",
		"Preserve the user's wording, casing, punctuation, whitespace, Markdown meaning, and language.",
		"Do not add tags, hashtags, links, headings, bullets, frontmatter, code blocks, or new Markdown structure.",
		"Return only compact JSON in this exact shape: {\"corrected\":\"...\"}.",
		"",
		JSON.stringify({ text }),
	].join("\n");
}

export function parseCorrectionResponse(content: string): string | null {
	const parsedJson = parseJsonCorrection(content);
	if (parsedJson !== null) {
		return parsedJson;
	}

	const tagMatch = content.match(/<corrected_text>([\s\S]*?)<\/corrected_text>/i);
	if (tagMatch) {
		return tagMatch[1];
	}

	return content.trim() ? content.trim() : null;
}

export function validateCorrection(
	original: string,
	candidate: string | null
): CorrectionValidation {
	if (candidate === null) {
		return { accepted: false, reason: "missing-correction" };
	}

	if (/\r?\n/.test(candidate)) {
		return { accepted: false, reason: "added-newline" };
	}

	const corrected = candidate.replace(/\r?\n/g, " ").trim();
	const originalTrimmed = original.trim();

	if (!corrected) {
		return { accepted: false, reason: "empty-correction" };
	}

	if (/there is no text provided/i.test(corrected)) {
	return { accepted: false, reason: "model-refusal-no-text" };
	}
	
	if (/please provide the text/i.test(corrected)) {
		return { accepted: false, reason: "model-refusal-request-text" };
	}
	
	if (/^```/.test(corrected.trim())) {
		return { accepted: false, reason: "returned-code-block" };
	}
	
	if (/^\{[\s\S]*"corrected"[\s\S]*\}$/.test(corrected.trim())) {
		return { accepted: false, reason: "returned-json-as-text" };
	}

	if (corrected === original) {
		return { accepted: false, reason: "unchanged" };
	}

	if (corrected.length > original.length * MAX_LENGTH_MULTIPLIER + MAX_LENGTH_SLACK) {
		return { accepted: false, reason: "too-long" };
	}

	if (!original.includes("#") && corrected.includes("#")) {
		return { accepted: false, reason: "added-hashtag" };
	}

	if (!original.includes("[[") && corrected.includes("[[")) {
		return { accepted: false, reason: "added-wikilink" };
	}

	if (!original.includes("](") && /\[[^\]]+\]\([^)]+\)/.test(corrected)) {
		return { accepted: false, reason: "added-markdown-link" };
	}

	if (!originalTrimmed.startsWith("#") && corrected.trimStart().startsWith("#")) {
		return { accepted: false, reason: "added-heading" };
	}

	if (!original.includes("```") && corrected.includes("```")) {
		return { accepted: false, reason: "added-code-fence" };
	}

	return { accepted: true, corrected };
}

function parseJsonCorrection(content: string): string | null {
	const direct = parseJsonObject(content);
	if (direct !== null) {
		return direct;
	}

	const objectMatch = content.match(/\{[\s\S]*\}/);
	return objectMatch ? parseJsonObject(objectMatch[0]) : null;
}

function parseJsonObject(content: string): string | null {
	try {
		const parsed = JSON.parse(content) as { corrected?: unknown };
		return typeof parsed.corrected === "string" ? parsed.corrected : null;
	} catch {
		return null;
	}
}

function countLetters(text: string): number {
	const matches = text.match(/\p{L}/gu);
	return matches ? matches.length : 0;
}

function isProtectedMarkdownLine(line: string): boolean {
	const trimmed = line.trim();

	return (
		// Fenced code block delimiter
		/^```/.test(trimmed) ||
		/^~~~/.test(trimmed) ||

		// Horizontal rule
		/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||

		// Empty heading: #, ##, ###
		/^#{1,6}\s*$/.test(trimmed) ||

		// Hashtag/tag, not heading: #tag
		/^#\S+$/.test(trimmed) ||

		// Table separator row: |---|---|
		/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)
	);
}

function isLikelyUrlOrEmail(text: string): boolean {
	return (
		/^https?:\/\//i.test(text) ||
		/^www\./i.test(text) ||
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
	);
}
