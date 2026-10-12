export type CapabilityName = "llm" | "python" | "search";

export interface Question {
	/** Stable identifier, unique within a task. */
	id: string;
	/** Text passed to the harness as `solve(question)`. */
	prompt: string;
	/** Gold answer: used by graders and shown in feedback reports for development questions. */
	answer: string;
	/** Grader-specific data. */
	meta?: Record<string, unknown>;
}

export interface Grade {
	/** In [0, 1]. */
	score: number;
	detail?: string;
}

export interface Passage {
	id: string;
	title: string;
	text: string;
}

export interface TaskInfo {
	name: string;
	description: string;
}

export interface Task extends TaskInfo {
	capabilities: CapabilityName[];
	/** Development pool: feedback and scoring questions are drawn from it. */
	dev: Question[];
	/** Held-out pool: never shown to the proposer and never used for selection. */
	heldout: Question[];
	grade(question: Question, answer: string): Promise<Grade>;
	/** Task-specific lines for a report example, for example retrieved versus missed supporting documents. */
	describeOutcome?(question: Question, outcome: QuestionOutcome): string | undefined;
	search?: SearchBackend;
	close?(): Promise<void>;
}

export interface Usage {
	input: number;
	output: number;
	cost: number;
}

export type OutcomeKind = "correct" | "partial" | "wrong" | "error" | "timeout" | "budget";

export const OUTCOME_KINDS: readonly OutcomeKind[] = ["correct", "partial", "wrong", "error", "timeout", "budget"];

export type ToolName = "llm" | "python" | "search" | "log";

export type BudgetedTool = "llm" | "python" | "search";

export interface TraceEvent {
	tool: ToolName;
	/** Milliseconds since the question started. */
	at: number;
	durationMs: number;
	input: string;
	output: string;
	error?: string;
	usage?: Usage;
}

export interface QuestionOutcome {
	questionId: string;
	answer: string | null;
	score: number;
	kind: OutcomeKind;
	error?: string;
	gradeDetail?: string;
	trace: TraceEvent[];
	durationMs: number;
	calls: Record<BudgetedTool, number>;
	usage: Usage;
}

export interface EvalResult {
	label: string;
	harnessHash: string;
	/** J(h; Q): mean grader score. */
	mean: number;
	counts: Record<OutcomeKind, number>;
	/** Fraction of questions whose execution finished without error, timeout or budget exhaustion. */
	completedFraction: number;
	outcomes: QuestionOutcome[];
	calls: Record<BudgetedTool, number>;
	usage: Usage;
	durationMs: number;
}

export interface SolverMessage {
	role: "user" | "assistant";
	content: string;
}

export interface SolverRequest {
	system?: string;
	messages: SolverMessage[];
	temperature?: number;
	maxTokens: number;
}

export interface SolverResponse {
	text: string;
	stopReason: string;
	usage: Usage;
}

export interface SolverClient {
	complete(request: SolverRequest, signal?: AbortSignal): Promise<SolverResponse>;
}

export interface ProposerRequest {
	system: string;
	messages: SolverMessage[];
}

export interface ProposerResponse {
	/** Final answer text only; thinking is excluded. */
	text: string;
	stopReason: string;
	usage: Usage;
	error?: string;
}

export interface ProposerClient {
	complete(request: ProposerRequest, signal?: AbortSignal): Promise<ProposerResponse>;
}

export interface PythonResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export interface PythonRunOptions {
	timeoutMs: number;
	stdin?: string;
	signal?: AbortSignal;
}

export interface PythonRunner {
	run(code: string, options: PythonRunOptions): Promise<PythonResult>;
}

export interface SearchBackend {
	search(query: string, k: number): Promise<Passage[]>;
}
