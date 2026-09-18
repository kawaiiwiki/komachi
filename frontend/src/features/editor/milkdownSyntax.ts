import { $node } from '@milkdown/kit/utils'
import { InitReady, remarkPluginsCtx } from '@milkdown/kit/core'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { RemarkPlugin } from '@milkdown/kit/transformer'

interface SyntaxNode {
  type: string
  children?: SyntaxNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  meta?: unknown
}

const supported = new Set([
  'paragraph',
  'text',
  'heading',
  'strong',
  'emphasis',
  'delete',
  'link',
  'image',
  'blockquote',
  'list',
  'listItem',
  'code',
  'inlineCode',
  'break',
  'thematicBreak',
  'table',
  'tableRow',
  'tableCell',
])

function needsProtection(node: SyntaxNode): boolean {
  return (
    !supported.has(node.type) ||
    (node.type === 'code' && Boolean(node.meta)) ||
    Boolean(node.children?.some(needsProtection))
  )
}

/** Keep extensions as opaque *source* blocks, never as executable HTML.
 * References/definitions and unknown remark nodes are protected as well.
 * Protecting the containing top-level block preserves list/quote context.
 */
export function protectMarkdownBlocks(tree: SyntaxNode, source: string) {
  tree.children = tree.children?.map((node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return node
    const raw = source.slice(start, end)
    const customSyntax =
      node.type !== 'code' && /\[\[|\[\^|==|\$\$|\[![A-Za-z][\w-]*\]/.test(raw)
    if (!customSyntax && !needsProtection(node)) return node
    return { type: 'komachiSource', value: raw, position: node.position }
  })
}

// Run BEFORE commonmark's inline-link/HTML transforms, which otherwise discard
// reference definitions and turn HTML into nodes before we can preserve source.
export const preservedMarkdown: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady)
  const plugin: RemarkPlugin = {
    options: {},
    plugin: () => (tree, file) => {
      protectMarkdownBlocks(tree, String(file))
    },
  }
  ctx.update(remarkPluginsCtx, (plugins) => [plugin, ...plugins])
  return () => {
    ctx.update(remarkPluginsCtx, (plugins) =>
      plugins.filter((p) => p !== plugin),
    )
  }
}

export const preservedMarkdownNode = $node('komachi_source', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  attrs: { source: { default: '' } },
  parseDOM: [
    {
      tag: 'pre[data-komachi-source]',
      getAttrs: (dom) => ({ source: dom.textContent ?? '' }),
    },
  ],
  toDOM: (node) => [
    'pre',
    {
      'data-komachi-source': '',
      class: 'milkdown-source-block',
      // Source is a text node, not innerHTML.
      contenteditable: 'false',
    },
    node.attrs.source,
  ],
  parseMarkdown: {
    match: (node) => node.type === 'komachiSource',
    runner: (state, node, type) => {
      state.addNode(type, { source: node.value })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'komachi_source',
    runner: (state, node) => {
      // remark's HTML writer emits this string verbatim. It is never rendered as HTML.
      state.addNode('html', undefined, node.attrs.source)
    },
  },
}))
