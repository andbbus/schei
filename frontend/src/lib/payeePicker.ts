// Pure helpers behind the payee / account combobox (PayeeInput.tsx).
//
// A picker row is either a regular payee (free text or an existing one) or one
// of the user's other accounts — choosing an account is what turns the entry
// into a transfer, so the menu lists both in one place. The backend mirrors the
// pair automatically once `transferAccountId` is sent.
//
// Kept side-effect free and tested (vitest) per the repo's "derived logic lives
// in dedicated modules" convention.

export const TRANSFER_PREFIX = 'Transfer : '

export interface PickerPayee {
  id: string
  name: string
}

export interface PickerAccount {
  id: string
  name: string
  onBudget?: boolean
  closed?: boolean
}

export interface PickerOption {
  kind: 'payee' | 'account'
  id: string
  name: string
  label: string
  value: string
}

// Case- and diacritic-insensitive fold, so "Città" matches "citta". Mirrors
// the backend rules engine's fold closely enough for menu filtering.
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('und')
}

// Accounts first (they are the less common, more deliberate choice), then
// payees; both alphabetical. Closed accounts and the account currently being
// edited are never offered as transfer targets.
export function buildPickerOptions(
  payees: PickerPayee[],
  accounts: PickerAccount[],
  opts: { excludeAccountId?: string } = {},
): PickerOption[] {
  const accts: PickerOption[] = accounts
    .filter((a) => !a.closed && a.id !== opts.excludeAccountId)
    .map((a): PickerOption => ({ kind: 'account', id: a.id, name: a.name, label: a.name, value: TRANSFER_PREFIX + a.name }))
    .sort((x, y) => x.name.localeCompare(y.name))
  // Legacy plain payees named "Transfer : X" (old imports / typed labels) would
  // duplicate the account rows and create unlinked rows when picked — hide them.
  const ps: PickerOption[] = payees
    .filter((p) => !p.name.startsWith(TRANSFER_PREFIX))
    .map((p): PickerOption => ({ kind: 'payee', id: p.id, name: p.name, label: p.name, value: p.name }))
    .sort((x, y) => x.name.localeCompare(y.name))
  return [...accts, ...ps]
}

export function filterPickerOptions(options: PickerOption[], query: string): PickerOption[] {
  const q = foldText(query.trim())
  if (!q) return options
  return options.filter((o) => foldText(o.name).includes(q) || foldText(o.value).includes(q))
}

// Resolve a typed string back to an account when it names one exactly
// ("Transfer : Banca X"). Lets a hand-typed transfer still produce the mirrored
// pair instead of silently becoming a payee named "Transfer : …".
export function matchTransferName(
  value: string,
  accounts: PickerAccount[],
  opts: { excludeAccountId?: string } = {},
): PickerAccount | null {
  if (!value.startsWith(TRANSFER_PREFIX)) return null
  const name = value.slice(TRANSFER_PREFIX.length)
  return acctsByName(accounts, opts).get(name) ?? null
}

// Transfer label for an account, centralised so display and matching agree.
export function transferLabel(account: { name: string }): string {
  return TRANSFER_PREFIX + account.name
}

function acctsByName(accounts: PickerAccount[], opts: { excludeAccountId?: string }): Map<string, PickerAccount> {
  const m = new Map<string, PickerAccount>()
  for (const a of accounts) {
    if (a.closed || a.id === opts.excludeAccountId) continue
    m.set(a.name, a)
  }
  return m
}
