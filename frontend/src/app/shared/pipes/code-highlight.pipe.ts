import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import Prism from 'prismjs';

import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-markdown';

const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  cs: 'csharp',
  csx: 'csharp',
  dockerfile: 'docker',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  txt: 'plaintext',
  text: 'plaintext',
  plaintext: 'plaintext',
};

/**
 * Highlights a single line of code using Prism.
 * Use with [innerHTML] and the sanitized result.
 */
@Pipe({
  name: 'codeHighlight',
  standalone: true,
})
export class CodeHighlightPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(line: string, language?: string | null): SafeHtml {
    if (line == null) return this.sanitizer.bypassSecurityTrustHtml('');
    const lang = this.normalizeLanguage(language);
    const grammar = Prism.languages[lang];
    
    // If no grammar found, just escape and return plain text
    if (!grammar) {
      return this.sanitizer.bypassSecurityTrustHtml(this.escapeHtml(line));
    }
    
    try {
      const highlighted = Prism.highlight(line, grammar, lang);
      return this.sanitizer.bypassSecurityTrustHtml(highlighted);
    } catch {
      return this.sanitizer.bypassSecurityTrustHtml(this.escapeHtml(line));
    }
  }

  private normalizeLanguage(lang?: string | null): string {
    if (!lang || typeof lang !== 'string') return 'plaintext';
    const lower = lang.toLowerCase().trim();
    return LANG_MAP[lower] || lower;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
