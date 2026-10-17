import * as React from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

interface Props {
  /** Fully formatted readout, e.g. "12.4M" or "$3.20". */
  readonly text: string;
  /** Changes when the number switches meaning (Token ↔ 费用). */
  readonly mode: string;
}

/**
 * Hero readout digits.
 * - Number Ticker: while the mode stays the same, each digit column rolls to
 *   its new value (place values are keyed from the right so they stay put
 *   when the number grows a digit).
 * - Mode switch (Token ↔ 费用): the old value is replaced at once and the new
 *   one fades up as a single block. There is deliberately no overlapping exit
 *   layer — two offset copies crossing each other read as a smear.
 * The visual layer is aria-hidden; screen readers get the plain text.
 */
export function ReadoutDigits({ text, mode }: Props): React.ReactElement {
  // The layer is keyed by mode, so it remounts on every switch; only mounts
  // after the first switch carry data-swap, which keeps the initial render and
  // ordinary stat refreshes still.
  const [initialMode] = React.useState(mode);
  const [everSwitched, setEverSwitched] = React.useState(false);
  if (mode !== initialMode && !everSwitched) setEverSwitched(true);
  const switched = everSwitched || mode !== initialMode;

  const chars = [...text];
  return (
    <span className="readout-digits">
      <span className="sr-only">{text}</span>
      <span className="digit-layer" key={mode} data-swap={switched ? '' : undefined} aria-hidden="true">
        {chars.map((char, index) => {
          const place = chars.length - index;
          const digit = DIGITS.indexOf(char);
          if (digit < 0) return <span key={`c${place}-${char}`} className="digit-char">{char}</span>;
          return (
            <span key={`d${place}`} className="digit-char digit-col">
              <span className="digit-strip" style={{ transform: `translateY(${-digit * 10}%)` }}>
                {DIGITS.map(d => <span key={d}>{d}</span>)}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
