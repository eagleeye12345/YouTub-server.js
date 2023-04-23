import Text from '../misc/Text.js';
import { YTNode } from '../../helpers.js';
import type { RawNode } from '../../index.js';

export default class UpdateDescriptionAction extends YTNode {
  static type = 'UpdateDescriptionAction';

  description: Text;

  constructor(data: RawNode) {
    super();
    this.description = new Text(data.description);
  }
}