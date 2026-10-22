// How a lock holds what it takes, named as PostgreSQL names it, and which
// modes make each other wait: the conflict tables of PostgreSQL's
// "Explicit Locking" chapter.

/** Row-level lock modes, weakest first: `SELECT … FOR …`. */
export const ROW_MODES = [
	"FOR KEY SHARE",
	"FOR SHARE",
	"FOR NO KEY UPDATE",
	"FOR UPDATE",
] as const;

/** Table-level lock modes, weakest first: `LOCK TABLE … IN … MODE`. */
export const TABLE_MODES = [
	"ACCESS SHARE",
	"ROW SHARE",
	"ROW EXCLUSIVE",
	"SHARE UPDATE EXCLUSIVE",
	"SHARE",
	"SHARE ROW EXCLUSIVE",
	"EXCLUSIVE",
	"ACCESS EXCLUSIVE",
] as const;

type RowMode = (typeof ROW_MODES)[number];
type TableMode = (typeof TABLE_MODES)[number];
type AdvisoryMode = "advisory" | "advisory shared";

/**
 * A lock's mode. `UPDATE` and `DELETE` are the row locks those statements
 * take: as strong as `FOR NO KEY UPDATE` and `FOR UPDATE`, under a
 * `ROW EXCLUSIVE` table lock where `SELECT … FOR …` takes `ROW SHARE`.
 */
export type Mode = RowMode | "UPDATE" | "DELETE" | TableMode | AdvisoryMode;

// Two row locks conflict when their strengths add up to 3 or more:
// `FOR KEY SHARE` (0) waits only for `FOR UPDATE` (3), `FOR SHARE` (1) for
// both updates, `FOR NO KEY UPDATE` (2) for all but `FOR KEY SHARE`.
const ROW_STRENGTH: Partial<Record<Mode, number>> = {
	"FOR KEY SHARE": 0,
	"FOR SHARE": 1,
	"FOR NO KEY UPDATE": 2,
	UPDATE: 2,
	"FOR UPDATE": 3,
	DELETE: 3,
};

const TABLE_CONFLICTS: Record<TableMode, readonly TableMode[]> = {
	"ACCESS SHARE": ["ACCESS EXCLUSIVE"],
	"ROW SHARE": ["EXCLUSIVE", "ACCESS EXCLUSIVE"],
	"ROW EXCLUSIVE": [
		"SHARE",
		"SHARE ROW EXCLUSIVE",
		"EXCLUSIVE",
		"ACCESS EXCLUSIVE",
	],
	"SHARE UPDATE EXCLUSIVE": [
		"SHARE UPDATE EXCLUSIVE",
		"SHARE",
		"SHARE ROW EXCLUSIVE",
		"EXCLUSIVE",
		"ACCESS EXCLUSIVE",
	],
	SHARE: [
		"ROW EXCLUSIVE",
		"SHARE UPDATE EXCLUSIVE",
		"SHARE ROW EXCLUSIVE",
		"EXCLUSIVE",
		"ACCESS EXCLUSIVE",
	],
	"SHARE ROW EXCLUSIVE": TABLE_MODES.slice(2),
	EXCLUSIVE: TABLE_MODES.slice(1),
	"ACCESS EXCLUSIVE": TABLE_MODES,
};

const isAdvisory = (mode: Mode): mode is AdvisoryMode =>
	mode === "advisory" || mode === "advisory shared";

export const isTableMode = (mode: Mode): mode is TableMode =>
	TABLE_MODES.some((table) => table === mode);

/** The table-level lock a mode takes along with its rows, or is. */
function tableModeOf(mode: Exclude<Mode, AdvisoryMode>): TableMode {
	if (isTableMode(mode)) return mode;
	return mode === "UPDATE" || mode === "DELETE" ? "ROW EXCLUSIVE" : "ROW SHARE";
}

/** Whether a lock held in one mode makes a request for the same lock in the other wait. */
export function conflicts(held: Mode, asked: Mode): boolean {
	if (isAdvisory(held) || isAdvisory(asked))
		return (
			isAdvisory(held) &&
			isAdvisory(asked) &&
			(held === "advisory" || asked === "advisory")
		);
	const heldRow = ROW_STRENGTH[held];
	const askedRow = ROW_STRENGTH[asked];
	if (heldRow !== undefined && askedRow !== undefined)
		return heldRow + askedRow >= 3;
	return TABLE_CONFLICTS[tableModeOf(held)].includes(tableModeOf(asked));
}

const ROW_LOCKS: readonly Mode[] = [...ROW_MODES, "UPDATE", "DELETE"];
const ADVISORY_LOCKS: readonly Mode[] = ["advisory", "advisory shared"];

/**
 * Whether a transaction that holds `held` waits for nobody when it asks for
 * `asked` on the same rows, table or key: every lock of `asked`'s kind that
 * would make it wait is one no other transaction can hold beside `held`.
 * A row request's own table-level lock is left out: it waits only for a
 * `LOCK TABLE`, and counting it would make a held row look fresh again.
 */
export function covers(held: Mode, asked: Mode): boolean {
	const kind =
		ROW_STRENGTH[asked] !== undefined
			? ROW_LOCKS
			: isAdvisory(asked)
				? ADVISORY_LOCKS
				: TABLE_MODES;
	return kind.every(
		(other) => !conflicts(asked, other) || conflicts(held, other),
	);
}
