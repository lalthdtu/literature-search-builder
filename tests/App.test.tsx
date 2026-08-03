// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/BibtexSourceEditor", () => ({
  BibtexSourceEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="BibTeX source" value={value} onChange={(event) => onChange(event.target.value)} />,
}));

import App from "@/App";

afterEach(cleanup);

const validSource = `@article{one,
  title={A virtual reality remote study},
  author={Doe, Jane},
  abstract={An online experiment with participants}
}`;

function importAndOpenDeduplication(source = validSource) {
  fireEvent.change(screen.getByLabelText("BibTeX source"), { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: /Validate & parse records/i }));
  fireEvent.click(screen.getByRole("button", { name: /Continue to deduplication/i }));
}

function continueThroughMetadata() {
  fireEvent.click(screen.getByRole("button", { name: /Continue to required metadata/i }));
  fireEvent.click(screen.getByRole("button", { name: /Apply metadata requirements/i }));
  fireEvent.click(screen.getByRole("button", { name: /Continue to query/i }));
}

describe("guided workflow", () => {
  it("locks later steps until import and deduplication are complete", () => {
    render(<App />);
    expect((screen.getByRole("tab", { name: /Deduplicate/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: /Define Query & Screen/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("BibTeX source"), { target: { value: validSource } });
    fireEvent.click(screen.getByRole("button", { name: /Validate & parse records/i }));

    expect((screen.getByRole("button", { name: /Continue to deduplication/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Continue to deduplication/i }));
    expect(screen.getByText(/No DOI- or title-based duplicate candidates/i)).toBeTruthy();
    continueThroughMetadata();
    expect((screen.getByRole("button", { name: /Run screening on 1 records/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps structural failures on the import step and blocks progression", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("BibTeX source"), { target: { value: "@article{broken, title={Missing}" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate & parse records/i }));
    expect(screen.getByText(/Parsing found blocking structural errors/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Continue to deduplication/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Insert 1 closing brace/i }));
    expect(screen.getByText(/Inserted the suggested closure and reparsed 1 valid records/i)).toBeTruthy();
  });

  it("runs a valid workflow directly into Results", () => {
    render(<App />);
    importAndOpenDeduplication();
    continueThroughMetadata();
    fireEvent.click(screen.getByRole("button", { name: /Run screening on 1 records/i }));
    expect(screen.getByRole("heading", { name: /Results and audit exports/i })).toBeTruthy();
    expect(screen.getByText("Screened")).toBeTruthy();
    expect(screen.getByText("Metadata removed")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Download complete workbook/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /CSV/i })).toBeNull();
  });

  it("requires a decision for each duplicate candidate group", () => {
    render(<App />);
    const duplicates = `@article{one, title={Same title}, author={Author}, doi={10.1/example}}\n@article{two, title={Same title}, author={Author}, doi={https://doi.org/10.1/example}}`;
    importAndOpenDeduplication(duplicates);
    expect((screen.getByRole("button", { name: /Continue to required metadata/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: /Choose as canonical/i })[0]);
    expect((screen.getByRole("button", { name: /Continue to required metadata/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("can choose the first record as canonical for every unresolved group", () => {
    render(<App />);
    const duplicates = `@article{a1, title={First duplicate}, author={One}, doi={10.1/a}}\n@article{a2, title={First duplicate}, author={Two}, doi={10.1/a}}\n@article{b1, title={Second duplicate}, author={Three}, doi={10.1/b}}\n@article{b2, title={Second duplicate}, author={Four}, doi={10.1/b}}`;
    importAndOpenDeduplication(duplicates);
    expect(screen.getAllByText("2", { selector: ".text-2xl" }).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: /Choose first for all unresolved/i }));
    expect((screen.getByRole("button", { name: /Continue to required metadata/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("button", { name: /Canonical record/i })).toHaveLength(2);
  });

  it("keeps old results inspectable but stale after an upstream edit", () => {
    render(<App />);
    importAndOpenDeduplication();
    continueThroughMetadata();
    fireEvent.click(screen.getByRole("button", { name: /Run screening on 1 records/i }));
    const importTab = screen.getByRole("tab", { name: /Import & Validate/i });
    fireEvent.mouseDown(importTab, { button: 0, ctrlKey: false });
    fireEvent.click(importTab);
    fireEvent.change(screen.getByLabelText("BibTeX source"), { target: { value: `${validSource}\n% edited` } });
    const resultsTab = screen.getByRole("tab", { name: /Results/i });
    fireEvent.mouseDown(resultsTab, { button: 0, ctrlKey: false });
    fireEvent.click(resultsTab);
    expect(screen.getByText(/results are out of date/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Download complete workbook/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Kept \.bib/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes records missing default Title or Author before screening", () => {
    render(<App />);
    importAndOpenDeduplication(`@article{missingAuthor, title={Title only}}`);
    fireEvent.click(screen.getByRole("button", { name: /Continue to required metadata/i }));
    expect(screen.getByText(/Missing Author \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/Missing Author/i, { selector: "span" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Jump to source/i }));
    expect(screen.getByRole("heading", { name: /Import and validate BibTeX/i })).toBeTruthy();
    const metadataTab = screen.getByRole("tab", { name: /Required Metadata/i });
    fireEvent.mouseDown(metadataTab, { button: 0, ctrlKey: false });
    fireEvent.click(metadataTab);
    fireEvent.click(screen.getByRole("button", { name: /Apply metadata requirements/i }));
    expect((screen.getByRole("button", { name: /Continue to query/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
