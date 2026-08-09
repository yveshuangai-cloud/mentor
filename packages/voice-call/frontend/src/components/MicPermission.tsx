/**
 * 麥克風權限請求 — 全螢幕美化版
 *
 * 取代瀏覽器醜醜的原生權限對話框。
 * 用戶點「好的」後才觸發真正的 getUserMedia，
 * 因為已經有了用戶手勢，瀏覽器會直接授權（或第一次會跳原生提示）。
 * 之後再次進入就不會再跳了。
 */

interface MicPermissionProps {
  /** 用戶同意 → 觸發 getUserMedia + 開始撥號 */
  onAllow: () => void;
  /** 用戶拒絕 → 關閉 LIFF */
  onDeny: () => void;
}

export default function MicPermission({ onAllow, onDeny }: MicPermissionProps) {
  return (
    <div className="fixed inset-0 bg-line-dark flex flex-col items-center justify-center px-6">
      {/* 頭像 + 麥克風徽章 */}
      <div className="relative mb-8">
        <div className="w-24 h-24 rounded-full overflow-hidden ring-2 ring-white/10">
          <img
            src="/avatar.jpg"
            alt="饅頭"
            className="w-full h-full object-cover"
          />
        </div>
        {/* 麥克風小徽章 */}
        <div className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-line-green flex items-center justify-center shadow-lg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="1" width="6" height="11" rx="3" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          </svg>
        </div>
      </div>

      {/* 標題 */}
      <p className="text-[19px] text-white font-medium text-center leading-relaxed">
        讓饅頭聽見你的聲音嗎？
      </p>

      {/* 說明小字 */}
      <p className="mt-2.5 text-[13px] text-white/40 text-center leading-relaxed">
        需要麥克風權限才能語音通話
      </p>

      {/* 按鈕區 */}
      <div className="mt-10 w-full max-w-[260px] flex flex-col gap-3">
        {/* 好的（主按鈕） */}
        <button
          onClick={onAllow}
          className="w-full py-3.5 rounded-full bg-line-green text-white text-[17px] font-medium active:scale-95 transition-transform shadow-lg shadow-line-green/20"
        >
          好的
        </button>

        {/* 關閉（次按鈕） */}
        <button
          onClick={onDeny}
          className="w-full py-3.5 rounded-full bg-white/8 text-white/50 text-[17px] active:scale-95 transition-transform"
        >
          關閉
        </button>
      </div>
    </div>
  );
}
