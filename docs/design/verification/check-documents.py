from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
markdown_files = list(root.rglob('*.md')) + [root.parents[1] / 'README.md']
links = []
issues = []
for document in markdown_files:
    for match in re.finditer(r'\[[^\]]*\]\(([^)]+)\)', document.read_text()):
        target = match.group(1).strip('<>')
        parsed = urlsplit(target)
        if parsed.scheme or not parsed.path:
            continue
        links.append(target)
        if not (document.parent / unquote(parsed.path)).exists():
            issues.append(f'{document.name}: {target}')
svg_files = list(root.rglob('*.svg'))
for svg in svg_files:
    node = ET.parse(svg).getroot()
    if not node.attrib.get('viewBox'):
        issues.append(f'{svg.name}: missing viewBox')
report = {'markdownFiles': len(markdown_files), 'localLinks': len(links), 'svgFiles': len(svg_files), 'issues': issues, 'result': 'passed' if not issues else 'failed'}
(root / 'verification/document-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
assert not issues
