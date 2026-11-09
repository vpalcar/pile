import type { CSSProperties, ReactNode } from "react";
import type { RailRow } from "../lib/stack-tree";

const LANE = 14;
const FIRST = 11; // centre of lane 0 in a 22px column
const RADIUS = 8; // of the corner where a branch joins its parent

/** Width of the rail column for a stack with `lanes` lanes. */
export const railWidth = (lanes: number) => 22 + (lanes - 1) * LANE;
const x = (lane: number) => FIRST + lane * LANE;

/**
 * The rail beside one row of a stack: lines passing through, the line from this
 * row's dot down to what it's built on, children joining it (straight from above or
 * with an elbow from the right), and the dot itself. `gap` is the space between rows,
 * which the lines bridge (half above, half below).
 */
export function RailCell({ row, lanes, node, gap = 0, dashed }: { row: RailRow; lanes: number; node: ReactNode; gap?: number; dashed?: boolean }) {
  const half = gap / 2;
  const line = (style: CSSProperties, key: string) => <i key={key} className={dashed ? "rail-line rail-line-dashed" : "rail-line"} style={style} />;
  return (
    <span className="relative block self-stretch" style={{ width: railWidth(lanes) }} aria-hidden>
      {row.through.map((l) => line({ left: x(l), top: -half, bottom: -half }, `t${l}`))}
      {row.up && line({ left: x(row.lane), top: -half, height: `calc(50% + ${half}px)` }, "up")}
      {row.down && line({ left: x(row.lane), top: "50%", bottom: -half }, "down")}
      {/* A join: down its lane, a rounded corner, then across to the dot. Drawn from the
          same 1.5px pieces as the straight lines so every part has the same weight. */}
      {row.joins.map((l) => (
        <span key={`j${l}`}>
          {line({ left: x(l), top: -half, height: `calc(50% + ${half - RADIUS}px)` }, `jv${l}`)}
          <svg className="rail-corner" style={{ left: x(l) - RADIUS, top: `calc(50% - ${RADIUS}px)` }} width={RADIUS} height={RADIUS} aria-hidden>
            <path d={`M ${RADIUS} 0 A ${RADIUS} ${RADIUS} 0 0 1 0 ${RADIUS}`} />
          </svg>
          <i className="rail-line rail-line-h" style={{ left: x(row.lane), width: x(l) - RADIUS - x(row.lane), top: "50%" }} />
        </span>
      ))}
      <span className="absolute top-1/2 z-[1] grid -translate-x-1/2 -translate-y-1/2 place-items-center" style={{ left: x(row.lane) }}>
        {node}
      </span>
    </span>
  );
}
