import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, MarkedExtension } from 'marked';
import { markedHighlight } from 'marked-highlight';
import Prism from 'prismjs';

// Import Prism languages
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

/**
 * Markdown to HTML pipe with Prism syntax highlighting
 */
@Pipe({
  name: 'markdown',
  standalone: true
})
export class MarkdownPipe implements PipeTransform {
  private static initialized = false;

  constructor(private sanitizer: DomSanitizer) {
    if (!MarkdownPipe.initialized) {
      // Configure marked with highlight extension
      marked.use(
        markedHighlight({
          langPrefix: 'language-',
          highlight: (code: string, lang: string) => {
            const language = this.getValidLanguage(lang || 'plaintext');
            if (Prism.languages[language]) {
              try {
                return Prism.highlight(code, Prism.languages[language], language);
              } catch {
                return code;
              }
            }
            return code;
          }
        }) as MarkedExtension
      );
      
      marked.setOptions({
        gfm: true,
        breaks: true,
      });
      
      MarkdownPipe.initialized = true;
    }
  }

  transform(value: string | null | undefined): SafeHtml {
    if (!value) return '';
    
    try {
      let html = marked.parse(value) as string;
      
      // Wrap code blocks with header
      html = html.replace(
        /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
        (_, lang, code) => `
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-lang">${lang}</span>
            </div>
            <pre class="code-block"><code class="language-${lang}">${code}</code></pre>
          </div>
        `
      );
      
      // Also handle code blocks without language
      html = html.replace(
        /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
        (_, code) => `
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-lang">code</span>
            </div>
            <pre class="code-block"><code>${code}</code></pre>
          </div>
        `
      );
      
      // Style inline code
      html = html.replace(
        /<code>([^<]+)<\/code>/g,
        '<code class="inline-code">$1</code>'
      );
      
      return this.sanitizer.bypassSecurityTrustHtml(html);
    } catch (error) {
      console.error('Markdown parsing error:', error);
      return this.sanitizer.bypassSecurityTrustHtml(`<pre>${this.escapeHtml(value)}</pre>`);
    }
  }
  
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  private getValidLanguage(lang: string): string {
    const map: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript', 
      'py': 'python',
      'sh': 'bash',
      'shell': 'bash',
      'yml': 'yaml',
      'html': 'markup',
      'xml': 'markup',
      'cs': 'csharp',
      'dockerfile': 'docker',
    };
    return map[lang.toLowerCase()] || lang.toLowerCase();
  }
}
