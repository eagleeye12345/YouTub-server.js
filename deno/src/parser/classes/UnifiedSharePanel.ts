import { YTNode } from '../helpers.ts';
import { Parser, type RawNode } from '../index.ts';

import StartAt from './StartAt.ts';
import CopyLink from './CopyLink.ts';
import SharePanelHeader from './SharePanelHeader.ts';
import ThirdPartyShareTargetSection from './ThirdPartyShareTargetSection.ts';

export type ThirdPartyNetworkSection = {
  share_target_container: ThirdPartyShareTargetSection | null,
  copy_link_container: CopyLink | null,
  start_at_container: StartAt | null
};

export default class UnifiedSharePanel extends YTNode {
  static type = 'UnifiedSharePanel';

  public third_party_network_section?: ThirdPartyNetworkSection;
  public header: SharePanelHeader | null;
  public share_panel_version: number;
  public show_loading_spinner?: boolean;

  constructor(data: RawNode) {
    super();
    if (data.contents) {
      const contents = data.contents.find((content: RawNode) => content.thirdPartyNetworkSection);

      if (contents) {
        this.third_party_network_section = {
          share_target_container: Parser.parseItem(contents.thirdPartyNetworkSection.shareTargetContainer, ThirdPartyShareTargetSection),
          copy_link_container: Parser.parseItem(contents.thirdPartyNetworkSection.copyLinkContainer, CopyLink),
          start_at_container: Parser.parseItem(contents.thirdPartyNetworkSection.startAtContainer, StartAt)
        };
      }
    }

    this.header = Parser.parseItem(data.header, SharePanelHeader);
    this.share_panel_version = data.sharePanelVersion;
    
    if (Reflect.has(data, 'showLoadingSpinner'))
      this.show_loading_spinner = data.showLoadingSpinner;
  }
}