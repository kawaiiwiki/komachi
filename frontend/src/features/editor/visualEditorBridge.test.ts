import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
} from '@milkdown/kit/core'
import {
  commonmark,
  wrapInBulletListCommand,
  updateLinkCommand,
} from '@milkdown/kit/preset/commonmark'
import { callCommand } from '@milkdown/kit/utils'
import { TextSelection } from '@milkdown/kit/prose/state'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { preservedMarkdown, preservedMarkdownNode } from './milkdownSyntax'
import { createVisualEditorBridge } from './visualEditorBridge'

const editors: Editor[] = []
afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.innerHTML = ''
})

async function setup(markdown: string) {
  const root = document.createElement('div')
  document.body.append(root)
  const onChange = vi.fn()
  const bridge = createVisualEditorBridge(onChange)
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, markdown)
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(preservedMarkdown)
    .use(preservedMarkdownNode)
    .use(bridge.plugin)
  editors.push(editor)
  await editor.create()
  bridge.start()
  return { editor, bridge, onChange, root }
}

const standard =
  '# 見出し\n\n**bold** and _italic_ and ~~strike~~ with `code` and [link](/ja/page).\n\n> quote\n\n1. ordered\n2. second\n\n- bullet\n- [x] task\n\n```go\nfmt.Println("日本語")\n```\n\n| a | b |\n| - | - |\n| c | d |\n\n---\n\n![image](/assets/id/test.png)\n'

describe('real Milkdown Markdown bridge', () => {
  it('opens the existing Markdown without publishing normalized content or marking it dirty', async () => {
    const { editor, root, onChange } = await setup(standard)
    expect(root.querySelector('h1')?.textContent).toBe('見出し')
    expect(root.querySelector('table')).not.toBeNull()
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      '/assets/id/test.png',
    )
    editor.action((ctx) => {
      const serialized = ctx.get(serializerCtx)(
        ctx.get(editorViewCtx).state.doc,
      )
      expect(ctx.get(serializerCtx)(ctx.get(parserCtx)(serialized))).toBe(
        serialized,
      )
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('records serializer formatting for existing Markdown', async () => {
    const { editor } = await setup(
      'Title\n=====\n\n__bold__ and *italic*\n\n* item\n* next\n\n| a | b |\n| - | - |\n| c | d |',
    )
    const normalized = editor.action((ctx) =>
      ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc),
    )
    expect(normalized).toMatchSnapshot()
  })

  it('documents spacing normalization only after a real Visual edit', async () => {
    const source =
      '# Heading ###\n\n\nparagraph  \nnext\n\n3. first\n9. second\n\n| long column | b |\n| --- | :---: |\n| c | d |'
    const { editor, onChange } = await setup(source)
    expect(onChange).not.toHaveBeenCalled()
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.insertText('New ', 1))
    })
    expect(onChange.mock.calls.at(-1)![0]).toMatchSnapshot()
  })

  it('publishes Visual edits synchronously, before save can read the store', async () => {
    const { editor, onChange } = await setup('# Before\n')
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.insertText('日本語', 1, 7))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange.mock.calls[0][0]).toContain('# 日本語')
    })
  })

  it('serializes Visual list and link command edits', async () => {
    const { editor, onChange } = await setup('first\n\n[link](/ja/old)')
    editor.action(callCommand(wrapInBulletListCommand.key))
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let linkPosition = 0
      view.state.doc.descendants((node, position) => {
        if (node.text === 'link') linkPosition = position
      })
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, linkPosition, linkPosition + 4),
        ),
      )
    })
    editor.action(callCommand(updateLinkCommand.key, { href: '/ja/new' }))
    const markdown: string = onChange.mock.calls.at(-1)![0]
    expect(markdown).toMatch(/[*-] first/)
    expect(markdown).toContain('[link](/ja/new)')
  })

  it('accepts repeated Raw syntax updates without echoing or replacing the view', async () => {
    const { editor, bridge, root, onChange } = await setup('original')
    const view = editor.action((ctx) => ctx.get(editorViewCtx))
    for (const source of [
      '# Heading',
      '- item\n- [ ] task',
      '[日本語](/ja/test)',
      '',
    ]) {
      editor.action((ctx) => bridge.replace(ctx, source))
      expect(editor.action((ctx) => ctx.get(editorViewCtx))).toBe(view)
    }
    expect(root.querySelector('.ProseMirror')).toBe(view.dom)
    expect(onChange).not.toHaveBeenCalled()
    view.dispatch(view.state.tr.insertText('new', 1))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it.each([
    '[[Page|別名]] and [[Folder/Page]]',
    '==highlight==',
    '$$a^2 + b^2$$',
    '> [!WARNING]\n> 日本語',
    '<video controls src="/assets/a.mp4"></video>',
    '<span style="color:red">HTML</span>',
    '[link][ref]\n\n[ref]: /ja/target "title"',
    'footnote[^one]\n\n[^one]: 日本語',
    '```ts {1,3}\nconst value = 1\n```',
  ])(
    'preserves extended syntax verbatim through unrelated Visual edits: %s',
    async (source) => {
      const { editor, root, onChange } = await setup('# Editable\n\n' + source)
      expect(root.querySelector('[data-komachi-source]')).not.toBeNull()
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText('New ', 1))
      })
      const output: string = onChange.mock.calls.at(-1)![0]
      for (const block of source.split('\n\n')) expect(output).toContain(block)
      expect(root.querySelector('video')).toBeNull()
    },
  )
})
