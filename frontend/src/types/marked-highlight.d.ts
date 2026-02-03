declare module 'marked-highlight' {
  import { MarkedExtension } from 'marked';
  
  export interface MarkedHighlightOptions {
    langPrefix?: string;
    highlight: (code: string, lang: string, info?: string) => string | Promise<string>;
    async?: boolean;
  }
  
  export function markedHighlight(options: MarkedHighlightOptions): MarkedExtension;
}
