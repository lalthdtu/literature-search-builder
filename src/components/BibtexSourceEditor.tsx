import { useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { BibtexDiagnostic } from "@/lib/bibtex";

type Props = {
  value: string;
  diagnostics: BibtexDiagnostic[];
  jumpTo?: { from: number; to: number; nonce: number } | null;
  onChange: (value: string) => void;
};

export function BibtexSourceEditor({ value, diagnostics, jumpTo, onChange }: Props) {
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const markers: Diagnostic[] = diagnostics.map((item) => ({
      from: Math.min(item.range.from, view.state.doc.length),
      to: Math.min(Math.max(item.range.to, item.range.from + 1), view.state.doc.length),
      severity: item.severity,
      message: `${item.message} ${item.guidance}`,
    }));
    view.dispatch(setDiagnostics(view.state, markers));
  }, [diagnostics, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpTo) return;
    const from = Math.min(jumpTo.from, view.state.doc.length);
    const to = Math.min(Math.max(from, jumpTo.to), view.state.doc.length);
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  }, [jumpTo]);

  return (
    <div className="overflow-hidden rounded-xl border bg-white" data-testid="bibtex-source-editor">
      <CodeMirror
        value={value}
        height="360px"
        basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true, bracketMatching: true }}
        extensions={[lintGutter()]}
        onCreateEditor={(view) => { viewRef.current = view; }}
        onChange={(nextValue) => onChange(nextValue)}
        theme="light"
      />
    </div>
  );
}
