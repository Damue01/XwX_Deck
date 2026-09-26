"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import * as React from "react";
import { cn } from "@/lib/utils";

type ConfirmTone = "default" | "danger";
type ConfirmSize = "default" | "wide";

export interface ConfirmOptions {
  readonly title: string;
  readonly body?: React.ReactNode;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly tone?: ConfirmTone;
  readonly size?: ConfirmSize;
}

export interface ConfirmCheckedOptions extends ConfirmOptions {
  readonly checkboxLabel: string;
  readonly checkboxDefaultChecked?: boolean;
}

export interface ConfirmCheckedResult {
  readonly confirmed: boolean;
  readonly checked: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
type ConfirmCheckedFn = (opts: ConfirmCheckedOptions) => Promise<ConfirmCheckedResult>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);
const ConfirmCheckedContext = React.createContext<ConfirmCheckedFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmDialogProvider");
  return confirm;
}

export function useConfirmChecked(): ConfirmCheckedFn {
  const confirm = React.useContext(ConfirmCheckedContext);
  if (!confirm) throw new Error("useConfirmChecked must be used within a ConfirmDialogProvider");
  return confirm;
}

interface DialogState extends ConfirmOptions {
  readonly open: boolean;
  readonly checkboxLabel?: string;
}

const CLOSED: DialogState = { open: false, title: "" };

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = React.useState<DialogState>(CLOSED);
  const [checked, setChecked] = React.useState(false);
  const resolverRef = React.useRef<((value: ConfirmCheckedResult) => void) | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const settle = React.useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(prev => ({ ...prev, open: false }));
    resolve?.({ confirmed: value, checked });
  }, [checked]);

  const request = React.useCallback<ConfirmCheckedFn>(opts => {
    // Resolve any dialog still pending before opening a new one.
    resolverRef.current?.({ confirmed: false, checked: false });
    return new Promise<ConfirmCheckedResult>(resolve => {
      resolverRef.current = resolve;
      setChecked(opts.checkboxDefaultChecked === true);
      setState({ ...opts, open: true });
    });
  }, []);
  const confirmChecked = request;
  const confirm = React.useCallback<ConfirmFn>(async opts => (
    await request({ ...opts, checkboxLabel: "" })
  ).confirmed, [request]);

  const tone = state.tone ?? "default";

  return (
    <ConfirmContext.Provider value={confirm}>
      <ConfirmCheckedContext.Provider value={confirmChecked}>
        {children}
      <AlertDialog.Root
        open={state.open}
        onOpenChange={open => {
          if (!open) {
            settle(false);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop
            className={cn(
              "fixed inset-0 z-80 bg-black/32 backdrop-blur-[2px] transition-opacity duration-200",
              "data-starting-style:opacity-0 data-ending-style:opacity-0 dark:bg-black/55",
            )}
          />
          <AlertDialog.Popup
            initialFocus={cancelRef}
            className={cn(
              "fixed top-1/2 left-1/2 z-80 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
              state.size === "wide" ? "max-w-[440px]" : "max-w-90",
              "rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg/10",
              "transition-[opacity,transform] duration-200 [transition-timing-function:cubic-bezier(.22,1,.36,1)]",
              "data-starting-style:scale-[.97] data-starting-style:opacity-0",
              "data-ending-style:scale-[.97] data-ending-style:opacity-0",
            )}
          >
            <AlertDialog.Title className="text-[15px] font-semibold tracking-[-.01em]">
              {state.title}
            </AlertDialog.Title>
            {state.body != null && (
              <AlertDialog.Description className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                {state.body}
              </AlertDialog.Description>
            )}
            {state.checkboxLabel && (
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px] text-popover-foreground">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={event => setChecked(event.currentTarget.checked)}
                  className="size-4 accent-[var(--accent)]"
                />
                <span>{state.checkboxLabel}</span>
              </label>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                className="btn"
                onClick={() => settle(false)}
              >
                {state.cancelText ?? "取消"}
              </button>
              <button
                type="button"
                className={cn("btn", tone === "danger" ? "danger" : "primary")}
                onClick={() => settle(true)}
              >
                {state.confirmText ?? "确定"}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      </ConfirmCheckedContext.Provider>
    </ConfirmContext.Provider>
  );
}
