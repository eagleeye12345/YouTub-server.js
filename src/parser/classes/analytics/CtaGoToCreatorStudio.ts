import { YTNode } from '../../helpers.js';
import type { RawNode } from '../../index.js';

export default class CtaGoToCreatorStudio extends YTNode {
  static type = 'CtaGoToCreatorStudio';

  title: string;
  use_new_specs: boolean;

  constructor(data: RawNode) {
    super();
    this.title = data.buttonLabel;
    this.use_new_specs = data.useNewSpecs;
  }
}