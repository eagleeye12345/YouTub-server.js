import Text from './misc/Text.js';
import NavigationEndpoint from './NavigationEndpoint.js';
import { YTNode } from '../helpers.js';
import type { RawNode } from '../index.js';

export default class SingleActionEmergencySupport extends YTNode {
  static type = 'SingleActionEmergencySupport';

  action_text: Text;
  nav_text: Text;
  details: Text;
  icon_type: string;
  endpoint: NavigationEndpoint;

  constructor(data: RawNode) {
    super();
    this.action_text = new Text(data.actionText);
    this.nav_text = new Text(data.navigationText);
    this.details = new Text(data.detailsText);
    this.icon_type = data.icon.iconType;
    this.endpoint = new NavigationEndpoint(data.navigationEndpoint);
  }
}