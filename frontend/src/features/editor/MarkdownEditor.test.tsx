import { act, fireEvent, render } from '@testing-library/react'
import { createRef, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownEditor, { type MarkdownEditorRef } from './MarkdownEditor'

const rawMount = vi.fn()
const visualMount = vi.fn()
let rawChange: (value: string) => void
let visualChange: (value: string) => void
let isMobile = false
vi.mock('@/lib/useIsMobile', () => ({ useIsMobile: () => isMobile }))
vi.mock('./MarkdownCodeEditor', () => ({
  default: function MockRaw({
    initialValue,
    onChange,
  }: {
    initialValue: string
    onChange: typeof rawChange
  }) {
    rawChange = onChange
    useEffect(() => {
      rawMount()
    }, [])
    return <div data-testid="raw" data-value={initialValue} />
  },
}))
vi.mock('./VisualMarkdownEditor', () => ({
  default: function MockVisual({
    markdown,
    onChange,
  }: {
    markdown: string
    onChange: typeof visualChange
  }) {
    visualChange = onChange
    useEffect(() => {
      visualMount()
    }, [])
    return <div data-testid="visual" data-value={markdown} />
  },
}))
vi.mock('./MarkdownToolbar', () => ({ default: () => <div /> }))

describe('dual Markdown editor', () => {
  beforeEach(() => {
    isMobile = false
    rawMount.mockClear()
    visualMount.mockClear()
  })
  it('opens both panes without changing the original source', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <MarkdownEditor
        pageId="a"
        initialValue={'__unchanged__\n'}
        onChange={onChange}
      />,
    )
    expect(getByTestId('visual')).toHaveAttribute(
      'data-value',
      '__unchanged__\n',
    )
    expect(getByTestId('raw')).toHaveAttribute('data-value', '__unchanged__\n')
    expect(onChange).not.toHaveBeenCalled()
  })
  it('publishes both edit sources immediately and exposes the latest Markdown to save callers', () => {
    const ref = createRef<MarkdownEditorRef>()
    const onChange = vi.fn()
    const { getByTestId } = render(
      <MarkdownEditor
        ref={ref}
        pageId="a"
        initialValue="original"
        onChange={onChange}
      />,
    )
    act(() => {
      visualChange('# 日本語')
    })
    expect(getByTestId('raw')).toHaveAttribute('data-value', '# 日本語')
    expect(ref.current?.getMarkdown()).toBe('# 日本語')
    act(() => {
      rawChange('- [x] タスク')
    })
    expect(getByTestId('visual')).toHaveAttribute('data-value', '- [x] タスク')
    expect(ref.current?.getMarkdown()).toBe('- [x] タスク')
    expect(onChange.mock.calls).toEqual([['# 日本語'], ['- [x] タスク']])
    expect(rawMount).toHaveBeenCalledTimes(1)
    expect(visualMount).toHaveBeenCalledTimes(1)
  })
  it('keeps both editor instances and edits across mobile tabs and breakpoints', () => {
    const props = { pageId: 'a', initialValue: 'original', onChange: vi.fn() }
    const { rerender, getByRole, getByTestId } = render(
      <MarkdownEditor {...props} />,
    )
    act(() => {
      rawChange('edited')
    })
    isMobile = true
    rerender(<MarkdownEditor {...props} />)
    fireEvent.click(getByRole('tab', { name: 'Raw Markdown' }))
    expect(getByTestId('raw')).toBeVisible()
    fireEvent.click(getByRole('tab', { name: 'Visual editor' }))
    expect(getByTestId('visual')).toBeVisible()
    expect(getByTestId('visual')).toHaveAttribute('data-value', 'edited')
    expect(rawMount).toHaveBeenCalledTimes(1)
    expect(visualMount).toHaveBeenCalledTimes(1)
  })
})
