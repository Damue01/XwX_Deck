import type {
  CodexConversationDetailRequest,
  CodexConversationHealthRow,
  CodexConversationPageRequest,
  CodexConversationPageResponse
} from '../../shared/codexConversationHealth';

export type CodexConversationWorkerRequest =
  | {
      readonly id: string;
      readonly type: 'page';
      readonly request: CodexConversationPageRequest;
      readonly cancelBuffer: SharedArrayBuffer;
    }
  | {
      readonly id: string;
      readonly type: 'detail';
      readonly request: CodexConversationDetailRequest;
    };

export type CodexConversationWorkerResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly type: 'page';
      readonly value: CodexConversationPageResponse;
    }
  | {
      readonly id: string;
      readonly ok: true;
      readonly type: 'detail';
      readonly value: CodexConversationHealthRow;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly cancelled: boolean;
      readonly error: string;
    };

