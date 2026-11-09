import type { Repository } from './adapters.ts';

// Read inside the job-creation transaction so a concurrent pause cannot be missed.
export async function generationEnabled(db: Repository): Promise<boolean> {
    const control = await db.get('operations', 'generation-control');
    if (!control) return true;
    return control.enabled === true;
}
