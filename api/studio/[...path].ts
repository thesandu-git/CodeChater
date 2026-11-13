import { makeRouter } from '../../server/router';
import type { Handler } from '../../server/router';
import * as routes from '../../server/studio';

export default makeRouter('studio', routes as unknown as Record<string, Handler>);
