import { Injectable, Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked, MarkedExtension } from 'marked';
import { MermaidDiagramService } from '../../core/services/mermaid-diagram.service';
import { markedHighlight } from 'marked-highlight';
import Prism from 'prismjs';
import mermaid from 'mermaid';

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

// Theme configurations for Mermaid
const darkThemeConfig = {
  theme: 'dark' as const,
  themeVariables: {
    primaryColor: '#8b5cf6',
    primaryTextColor: '#e6edf3',
    primaryBorderColor: '#6366f1',
    lineColor: '#8b949e',
    secondaryColor: '#21262d',
    tertiaryColor: '#161b22',
    background: '#0d1117',
    mainBkg: '#161b22',
    secondBkg: '#21262d',
    nodeBorder: '#6366f1',
    clusterBkg: '#21262d',
    clusterBorder: '#30363d',
    titleColor: '#e6edf3',
    edgeLabelBackground: '#21262d',
    nodeTextColor: '#e6edf3',
  },
};

const lightThemeConfig = {
  theme: 'default' as const,
  themeVariables: {
    primaryColor: '#8b5cf6',
    primaryTextColor: '#24292f',
    primaryBorderColor: '#6366f1',
    lineColor: '#57606a',
    secondaryColor: '#f6f8fa',
    tertiaryColor: '#ffffff',
    background: '#ffffff',
    mainBkg: '#f6f8fa',
    secondBkg: '#eaeef2',
    nodeBorder: '#6366f1',
    clusterBkg: '#f6f8fa',
    clusterBorder: '#d0d7de',
    titleColor: '#24292f',
    edgeLabelBackground: '#f6f8fa',
    nodeTextColor: '#24292f',
  },
};

/** Get current theme from document */
function getCurrentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Initialize mermaid with current theme */
function initMermaidWithTheme() {
  const isDark = getCurrentTheme() === 'dark';
  const themeConfig = isDark ? darkThemeConfig : lightThemeConfig;
  
  mermaid.initialize({
    startOnLoad: false,
    ...themeConfig,
    flowchart: {
      curve: 'basis',
      padding: 15,
    },
    securityLevel: 'loose',
  });
}

// Initial mermaid setup
initMermaidWithTheme();

let mermaidIdCounter = 0;

/**
 * Markdown to HTML pipe with Prism syntax highlighting and Mermaid diagrams
 */
@Injectable({ providedIn: 'root' })
@Pipe({
  name: 'markdown',
  standalone: true
})
export class MarkdownPipe implements PipeTransform {
  private static initialized = false;

  constructor(
    private sanitizer: DomSanitizer,
    private mermaidDiagramService: MermaidDiagramService
  ) {
    if (!MarkdownPipe.initialized) {
      // Configure marked with highlight extension
      marked.use(
        markedHighlight({
          langPrefix: 'language-',
          highlight: (code: string, lang: string) => {
            // Don't highlight mermaid - we'll handle it separately
            if (lang === 'mermaid') {
              return code;
            }
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
      // Strip Zed's internal system prompt / edit format instructions that leak into responses
      let processedValue = this.stripZedSystemPrompt(value);

      // Extract <edits> blocks as placeholders (will inject styled HTML after markdown parsing)
      const diffBlocks: { id: string; html: string }[] = [];
      let diffCounter = 0;
      processedValue = processedValue.replace(
        /<edits>([\s\S]*?)<\/edits>/g,
        (_match, inner: string) => {
          const id = `DIFFBLOCK${diffCounter++}DIFFBLOCK`;
          diffBlocks.push({ id, html: this.buildDiffHtml(inner) });
          return id;
        }
      );
      // Also handle standalone old_text/new_text pairs not wrapped in <edits>
      processedValue = processedValue.replace(
        /<old_text[^>]*>([\s\S]*?)<\/old_text>\s*<new_text>([\s\S]*?)<\/new_text>/g,
        (_match) => {
          const id = `DIFFBLOCK${diffCounter++}DIFFBLOCK`;
          diffBlocks.push({ id, html: this.buildDiffHtml(_match) });
          return id;
        }
      );
      // Clean up any remaining stray edit tags
      processedValue = processedValue.replace(/<\/?(?:edits|old_text|new_text)[^>]*>/g, '');

      // Convert raw HTML img tags to markdown so they render (marked escapes raw HTML by default)
      processedValue = processedValue.replace(
        /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*(?:alt\s*=\s*["']([^"']*)["'])?[^>]*\/?>/gi,
        (_, src, alt = '') => `![${alt}](${src})`
      );
      
      // Extract mermaid blocks before parsing
      const mermaidBlocks: { id: string; code: string }[] = [];
      processedValue = processedValue.replace(
        /```mermaid\s*([\s\S]*?)```/g,
        (_, code) => {
          const id = `mermaid-${++mermaidIdCounter}`;
          mermaidBlocks.push({ id, code: code.trim() });
          return `<div class="mermaid-placeholder" data-mermaid-id="${id}"></div>`;
        }
      );
      
      let html = marked.parse(processedValue) as string;
      
      // Replace mermaid placeholders with actual mermaid containers
      // Store the original code in data attribute for potential re-rendering
      mermaidBlocks.forEach(({ id, code }) => {
        const escapedCode = this.escapeHtml(code);
        const base64Code = btoa(encodeURIComponent(code));
        html = html.replace(
          `<div class="mermaid-placeholder" data-mermaid-id="${id}"></div>`,
          `<div class="mermaid-wrapper" data-mermaid-source="${base64Code}">
            <div class="mermaid-header">
              <div class="mermaid-header-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                </svg>
                <span>Diagram</span>
              </div>
              <button type="button" class="mermaid-expand-btn" title="Open large view with zoom and pan" aria-label="Open diagram in large view">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="15 3 21 3 21 9"/>
                  <polyline points="9 21 3 21 3 15"/>
                  <line x1="21" y1="3" x2="14" y2="10"/>
                  <line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
                <span>Expand</span>
              </button>
            </div>
            <div class="mermaid" id="${id}">${escapedCode}</div>
          </div>`
        );
      });
      
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
      
      // Add table wrapper for responsive tables
      html = html.replace(
        /<table>/g,
        '<div class="table-wrapper"><table>'
      );
      html = html.replace(
        /<\/table>/g,
        '</table></div>'
      );
      
      // Schedule mermaid rendering after DOM update
      // Use longer delay to ensure theme is properly set
      if (mermaidBlocks.length > 0) {
        setTimeout(() => {
          // Re-initialize mermaid with current theme before rendering
          initMermaidWithTheme();
          
          mermaidBlocks.forEach(({ id }) => {
            const element = document.getElementById(id);
            if (element && !element.hasAttribute('data-processed')) {
              try {
                mermaid.run({ nodes: [element] }).then(() => {
                  this.mermaidDiagramService.postProcessLabelContainers();
                }).catch((e) => {
                  console.warn('Mermaid rendering failed for', id, e);
                });
              } catch (e) {
                console.warn('Mermaid rendering failed for', id, e);
              }
            }
          });
        }, 200);
      }
      
      // Re-inject diff block HTML (was extracted before markdown parsing to avoid escaping)
      for (const { id, html: diffHtml } of diffBlocks) {
        html = html.replace(id, diffHtml);
        // Also handle if marked wrapped the placeholder in a <p> tag
        html = html.replace(`<p>${id}</p>`, diffHtml);
      }

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

  /**
   * Build styled diff HTML from an <edits> block inner content.
   */
  private buildDiffHtml(inner: string): string {
    const editRegex = /<old_text[^>]*?(?:\s+line=(\d+))?[^>]*>([\s\S]*?)<\/old_text>\s*<new_text>([\s\S]*?)<\/new_text>/g;
    const diffs: string[] = [];
    let m;

    while ((m = editRegex.exec(inner)) !== null) {
      const startLine = m[1] ? parseInt(m[1], 10) : null;
      const oldLines = m[2].trim().split('\n');
      const newLines = m[3].trim().split('\n');

      let lineNum = startLine || 1;
      let rows = '';

      for (const line of oldLines) {
        rows += `<tr class="diff-row diff-removed"><td class="diff-gutter diff-gutter-removed">${lineNum}</td><td class="diff-sign">−</td><td class="diff-code">${this.escapeHtml(line)}</td></tr>`;
        lineNum++;
      }
      for (const line of newLines) {
        rows += `<tr class="diff-row diff-added"><td class="diff-gutter diff-gutter-added">${startLine ? lineNum : '+'}</td><td class="diff-sign">+</td><td class="diff-code">${this.escapeHtml(line)}</td></tr>`;
        lineNum++;
      }

      diffs.push(
        `<div class="diff-block">` +
        `<div class="diff-header"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M3 12h18"/></svg><span>Change${startLine ? ` at line ${m[1]}` : ''}</span></div>` +
        `<table class="diff-table"><tbody>${rows}</tbody></table>` +
        `</div>`
      );
    }

    return diffs.length > 0 ? diffs.join('') : '';
  }

  /**
   * Strip Zed's internal system prompt boilerplate that sometimes leaks into assistant messages.
   * This includes the edit format instructions, file editing instructions, etc.
   */
  private stripZedSystemPrompt(text: string): string {
    let result = text;

    // Match the entire Zed system prompt block:
    // Starts with optional "You\n" then "You MUST respond with a series of edits..."
    // Ends with "must exactly match existing" (and any trailing text on that line)
    result = result.replace(
      /(?:You\s*\n)?You\s+MUST\s+respond\s+with\s+a\s+series\s+of\s+edits[\s\S]*?must\s+exactly\s+match\s+existing[^\n]*/gi,
      ''
    );

    // Fallback: if the block doesn't end with "must exactly match existing",
    // catch "You MUST respond" through the closing ``` of the example code block
    result = result.replace(
      /You\s+MUST\s+respond\s+with\s+a\s+series\s+of\s+edits[\s\S]*?```/g,
      ''
    );

    // Catch standalone "# File Editing Instructions" sections
    result = result.replace(
      /#+\s*File Editing Instructions[\s\S]*?(?=\n\n[A-Z]|\n\n#[^#]|$)/g,
      ''
    );

    // Clean up excessive blank lines
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
  }
}
