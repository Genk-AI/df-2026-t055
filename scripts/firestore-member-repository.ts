import { configuredRepository } from '../apps/api/src/firestore-repository.ts';

if (process.env.REPOSITORY_BACKEND !== 'firestore') throw Error('FIRESTORE_REPOSITORY_REQUIRED');
export const repository = configuredRepository();
