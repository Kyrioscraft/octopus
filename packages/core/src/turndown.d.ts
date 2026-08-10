declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    hr?: string;
    bulletListMarker?: string;
    codeBlockStyle?: "indented" | "fenced";
    fence?: string;
    emDelimiter?: string;
    strongDelimiter?: string;
    linkStyle?: "inlined" | "referenced";
    linkReferenceStyle?: "full" | "collapsed" | "shortcut";
    preformattedCode?: boolean;
  }

  class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string | Document): string;
    addRule(key: string, rule: object): void;
    keep(filter: string | string[]): void;
    remove(filter: string | string[]): void;
    use(plugin: object | object[]): void;
    escape(str: string): string;
  }

  export default TurndownService;
}
