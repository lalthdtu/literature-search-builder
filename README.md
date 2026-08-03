# Literature Search Builder

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Validate, deduplicate, and filter BibTeX libraries using a guided client-side workflow with strict block criteria and PRISMA-oriented audit exports.

## Features

- 🧭 **Gated Workflow** - Import validation, duplicate review, metadata cleanup, query definition, and results cannot silently get out of sequence
- 🧾 **Source Diagnostics** - Line-numbered BibTeX editor with structural markers and jump-to-error guidance
- 🧹 **Auditable Deduplication** - DOI/title candidate groups with manual keep-or-merge decisions and enrichment provenance
- 🧼 **Required Metadata Cleanup** - Remove records missing configurable canonical fields after duplicate enrichment
- 🔍 **Block-based Query Builder** - Import supported Boolean searches or edit authoritative blocks
- 🎯 **Multi-field Search** - Search across Title, Abstract, and Keywords
- ✅ **Strict Screening Criteria** - Require every inclusion block and reject matches in exclusion blocks
- 🧩 **Validated Query Parsing** - Parse block-shaped AND/OR/NOT searches without silently dropping unsupported syntax
- 👁️ **Results Preview** - Inspect kept records, exclusions, block statuses, evidence, and reason totals before export
- 🎨 **Regex Support** - Optional regular expression matching for advanced queries
- 📊 **Term Statistics** - View match counts and distribution across your library
- 💾 **PRISMA Audit Workbook** - Export a structured `.xlsx` containing every record state, decision audit, configuration, and reconciled flow summary
- 📖 **Full-Text Assessment Template** - Review kept records offline with validated decisions, project-defined exclusion reasons, completeness checks, and live summaries
- ⚙️ **Project Export/Import** - Resume source, metadata requirements, query blocks, and duplicate decisions
- 🌐 **Client-side Processing** - All processing happens in your browser, keeping your data private

## Installation

This project is built with React, Vite, Tailwind CSS, and shadcn/ui components.

### Prerequisites

- Node.js (v18 or higher)
- npm

### Setup

```bash
# Clone the repository
git clone https://github.com/lalthdtu/literature-search-builder.git
cd literature-search-builder

# Install dependencies
npm install

# Start development server
npm run dev
```

Open your browser and go to the URL displayed in your terminal (for example, `http://localhost:3000`; the port may vary).

## Usage

1. **Open the application** in your browser

2. **Import & Validate**
   - Paste, upload, or drag in a `.bib` file
   - Select **Validate & parse records** to create a stable snapshot
   - Repair highlighted structural errors using the line markers and grouped diagnostics
   - For embedded or unfinished entries, use the diagnostic’s explicit closure button to insert the calculated missing quote/braces and immediately reparse
   - Review present and missing record counts for common citation fields
   - Source edits make the parsed snapshot out of date and lock later steps until validation is rerun

3. **Deduplicate**
   - Review candidate groups created from exact normalized DOI or title matches
   - Confirm that all records are distinct, or choose a canonical record and remove the others
   - Optionally fill missing canonical fields from removed records
   - Resolve every group before continuing; cite keys are never duplicate evidence

4. **Required Metadata**
   - Configure which canonical fields every deduplicated record must contain
   - New projects require Title and Author by default
   - Preview failing records grouped by their missing fields and jump back to the source when corrections are needed
   - Apply the rules to remove incomplete records before screening

5. **Define Query & Screen**
   - Paste a supported Boolean query and parse it into blocks, or edit blocks directly
   - The blocks are authoritative; the application displays the current generated expression
   - Choose Title, Abstract, and/or Keywords as searchable fields independently from metadata requirements
   - Fix empty terms and invalid regular expressions using the readiness checklist
   - **Run screening** becomes available only when every upstream requirement is complete

6. **Results**
   - Search and page through kept and excluded records
   - Compare Matched/Not matched status for every labeled block
   - Expand a row to inspect the matching terms and fields
   - Review imported, valid, duplicate-removed, metadata-removed, screened, kept, and excluded totals
   - Download one complete audit workbook containing every summary, record state, removal audit, screening decision, and cite-key mapping
   - Export the kept records as BibTeX for the next review step

7. **Resume Work**
   - Export a versioned project JSON containing the source, requirements, query, and duplicate decisions
   - Project import reparses and validates the source; screening results must be rerun
   - Legacy query configuration JSON remains loadable

## Query Syntax

### Screening Rules

- **Required blocks**: Every required block must match for a record to be kept
- **Terms within a block**: Combined with OR
- **Exclusion blocks**: Any match excludes the record
- **NOT syntax**: Both `NOT (...)` and `AND NOT (...)` introduce an exclusion block
- **Quotes**: Use for exact phrase matching
- **Supported shape**: Parenthesized OR-term blocks joined by AND; unsupported nesting or database-specific operators produce an error
- **Missing searchable data**: Records without content in the selected fields are excluded with a dedicated reason

### Example Queries

```
("virtual reality" OR "immersive virtual reality") AND ("remote study" OR "online study") AND (participant)
```

This query creates three required blocks and keeps entries that:
- Contain "virtual reality" OR "immersive virtual reality"
- AND contain "remote study" OR "online study"  
- AND contain "participant"

```
(machine learning OR "deep learning") AND NOT (survey OR review)
```

This query creates two required blocks and one exclusion block. It keeps entries that:
- Contain "machine learning" OR "deep learning"
- AND do NOT contain "survey" or "review"

## Export Options

### PRISMA audit workbook

**Download complete workbook** creates a client-side `.xlsx` from the last successful run. It begins with a reconciled PRISMA-oriented overview and contains fixed worksheets for:

- Import, deduplication, required-metadata, and screening summaries
- Validated records, records after deduplication, and records reaching screening
- Every duplicate-candidate decision and enrichment provenance
- Metadata removals
- Combined screening decisions plus separate kept and excluded record states
- Primary exclusion-reason totals, query configuration, term statistics, diagnostics, and cite-key mappings
- A workbook-only manual full-text assessment table, live full-text summary, and editable project-specific exclusion-reason list

Record worksheets use structured citation columns and include the complete reconstructed BibTeX entry. Very long entries are split across numbered BibTeX columns instead of being truncated. Empty audit categories remain present as labelled worksheets so every workbook has a stable structure.

Screening reasons are generated from the configured blocks and use these forms:

- `Required block not matched: {block name}`
- `Exclusion block matched: {block name}`
- `Missing searchable data`

When several reasons apply, the first reason in configured block order is primary, so every record contributes to exactly one exclusion-summary count.

The generated automatic results describe cleanup and screening before full-text assessment. The workbook additionally provides an offline manual assessment template for the kept records. Decisions entered there are calculated inside Excel and are not imported, persisted, or displayed by the web application.

The Results step represents the last successful execution. Editing BibTeX data, requirements, searchable fields, duplicate decisions, terms, labels, or exclusions marks that snapshot as out of date and disables derived exports until screening is rerun.

### Audit boundaries

The workbook documents every duplicate candidate record, including keep-all decisions, canonical choices, removed records, matching evidence, and fields used for enrichment. Duplicate removals are reported separately from screening exclusions.

Repeated cite keys are reported as source-data collisions but are not duplicate evidence. When retained records share a key, the exported `.bib` adds deterministic suffixes and the workbook's `CiteKey Mapping` worksheet records the mapping. All other worksheets retain original cite keys.

Metadata removals occur after deduplication enrichment and before query screening. The workbook records the complete required-field set, primary missing field, all missing fields, and the automatic `pre_screening_cleanup` decision for each removed canonical record.

### Manual full-text assessment

`Full-Text Assessment` contains every kept record and editable columns for the decision, primary exclusion reason, reviewer, assessment date, and notes. Decisions use `Not assessed`, `Include`, `Exclude`, or `Unclear`; the completeness column identifies missing reviewer, date, or exclusion-reason information.

Enter project-specific reasons in the 100 blank yellow cells on `Assessment Lists`. The decision and reason dropdowns reference these workbook lists. `Full-Text Summary` and the manual section of `Overview` update when Excel recalculates the workbook. Manual full-text exclusions remain separate from the automatic `Exclusion Summary` and represent reports/records rather than consolidated studies.

### BibTeX Export
Exports a reconstructed `.bib` file containing the records kept for the next step and all parsed fields. Deterministic suffixes make colliding cite keys unique in this file only.

## Technical Details

- **Client-side Processing**: All BibTeX parsing and filtering happens in your browser - no data is sent to any server
- **Responsive Design**: Works on desktop and mobile devices
- **Performance**: Handles large BibTeX libraries efficiently
- **Privacy**: Your research data never leaves your machine

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

---

Built with [React](https://react.dev/), [Vite](https://vite.dev/), [Tailwind CSS](https://tailwindcss.com/), and [shadcn/ui](https://ui.shadcn.com/)
