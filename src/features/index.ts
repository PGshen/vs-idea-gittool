import { Ctx } from '../context';

/** Feature modules. Each registers its commands, views and providers. */
export const FEATURES: ((ctx: Ctx) => void)[] = [];
