import { Ctx } from '../context';
import * as commit from './commit';
import * as localHistory from './localHistory';
import * as log from './log';
import * as ops from './ops';

/** Feature modules. Each registers its commands, views and providers. */
export const FEATURES: ((ctx: Ctx) => void)[] = [commit.register, log.register, ops.register, localHistory.register];
