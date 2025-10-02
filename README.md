# Literature Search Builder

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Filter BibTeX libraries by Title/Abstract/Keywords using block-based queries with AND/OR/NOT logic, optional Regex support, term statistics, and export results to CSV or .bib format.

## Features

- 🔍 **Block-based Query Builder** - Intuitive interface for constructing complex search queries
- 🎯 **Multi-field Search** - Search across Title, Abstract, and Keywords
- 🔀 **Boolean Logic** - Combine terms with AND/OR/NOT operators
- 🎨 **Regex Support** - Optional regular expression matching for advanced queries
- 📊 **Term Statistics** - View match counts and distribution across your library
- 💾 **Export Options** - Save results as CSV or filtered .bib files
- ⚙️ **Save/Load Configs** - Reuse your queries across sessions
- 🌐 **Client-side Processing** - All processing happens in your browser, keeping your data private

## Installation

This project is built with Next.js, Tailwind CSS, and shadcn/ui components.

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

Open your browser and navigate to the URL shown in your terminal

## Usage

1. **Open the application** in your browser (default: `http://localhost:3000/literature`)

2. **Paste BibTeX** (Tab 1)
   - Copy your BibTeX library entries
   - Paste them into the text area
   - The parser will automatically extract entries

3. **Build Query** (Tab 2)
   - Add search blocks and terms
   - Configure AND/OR logic between groups
   - Toggle Regex matching per term
   - Apply NOT operator to exclude matches
   - Select which fields to search (Title/Abstract/Keywords)

4. **Run & Report** (Tab 3)
   - View matching entries and statistics
   - See term frequency and distribution
   - Export results to CSV (metadata table)
   - Export results to .bib (filtered BibTeX file)

5. **Save/Load Configuration**
   - Save your query configuration for future use
   - Load previously saved queries

## Query Syntax

### Boolean Logic Rules

- **Top-level groups**: Combined with AND
- **Terms within a group**: Combined with OR
- **NOT operator**: Prefix a group to exclude matches
- **Quotes**: Use for exact phrase matching
- **Parentheses**: Group terms for complex queries

### Example Queries

```
("virtual reality" OR "immersive virtual reality") AND ("remote study" OR "online study") AND (participant)
```

This query finds entries that:
- Contain "virtual reality" OR "immersive virtual reality"
- AND contain "remote study" OR "online study"  
- AND contain "participant"

```
(machine learning OR "deep learning") AND NOT (survey OR review)
```

This query finds entries that:
- Contain "machine learning" OR "deep learning"
- AND do NOT contain "survey" or "review"

## Export Options

### CSV Export
Exports a table with the following columns:
- Entry ID
- Title
- Authors
- Year
- Publication venue
- Abstract (if available)
- Keywords (if available)

### BibTeX Export
Exports a filtered .bib file containing only the matched entries, preserving the original BibTeX formatting and all fields.

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

Built with [Next.js](https://nextjs.org/), [Tailwind CSS](https://tailwindcss.com/), and [shadcn/ui](https://ui.shadcn.com/)
