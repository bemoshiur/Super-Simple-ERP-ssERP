'use server'

import { revalidatePath } from 'next/cache'
import { getDb } from '../db'
import { updateSettings } from '../settings/settings'
import { guarded, type ActionResult } from './guard'

export async function updateSettingsAction(input: unknown): Promise<ActionResult> {
  return guarded('settings.edit', async (s) => {
    await updateSettings(getDb(), s.cid, s.uid, input)
    revalidatePath('/settings')
  })
}
