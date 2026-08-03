// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string, update: object) => void }) => (
    <textarea aria-label="Mock CodeMirror" value={value} onChange={(event) => onChange(event.target.value, { view: {}, transactions: [], changedRanges: [] })} />
  ),
}));

vi.mock("@codemirror/lint", () => ({
  lintGutter: () => [],
  setDiagnostics: () => ({}),
}));

import { BibtexSourceEditor } from "@/components/BibtexSourceEditor";

afterEach(cleanup);

describe("BibtexSourceEditor", () => {
  it("forwards only source text and never leaks CodeMirror's ViewUpdate object", () => {
    const onChange = vi.fn();
    render(<BibtexSourceEditor value="" diagnostics={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Mock CodeMirror"), { target: { value: "@article{one, title={One}}" } });
    expect(onChange).toHaveBeenCalledWith("@article{one, title={One}}");
    expect(onChange.mock.calls[0]).toHaveLength(1);
  });
});
