import '@/lib/i18n'
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import AccountSettings from './AccountSettings'

vi.mock('../../viewer/setTitle', () => ({ useSetTitle: vi.fn() }))
vi.mock('./ChangeOwnPasswordPanel', () => ({
  ChangeOwnPasswordPanel: () => <div>Password controls</div>,
}))
vi.mock('./PreferencesPanel', () => ({
  PreferencesPanel: () => <div>Preference controls</div>,
}))
vi.mock('./TotpPanel', () => ({ TotpPanel: () => null }))

it('keeps account settings without profile picture controls', () => {
  const { container } = render(<AccountSettings />)

  expect(screen.getByText('Password controls')).toBeInTheDocument()
  expect(screen.getByText('Preference controls')).toBeInTheDocument()
  expect(screen.queryByText('Profile Picture')).not.toBeInTheDocument()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})
