const fetch = require('node-fetch');
const admin = require('firebase-admin');

// サービスアカウントキーを環境変数から読み込む
// NetlifyのUIで FIREBASE_SERVICE_ACCOUNT_JSON というキーで設定します
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e);
}

// Firebase Admin SDKを初期化
// 一度だけ初期化するようにチェック
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (e) {
        console.error('Firebase Admin initialization error:', e);
    }
}

const db = admin.firestore();

/**
 * Firestoreから指定されたユーザーの直近の記録を取得するヘルパー関数
 * @param {string} appId - アプリID
 * @param {string} userId - 利用者ID
 * @returns {Promise<Array<Object>>} - 直近5件の記録データ
 */
async function getRecentRecordsForUser(appId, userId) {
    const recordsRef = db.collection(`artifacts/${appId}/public/data/records`);
    const q = recordsRef.where("userId", "==", userId);
    
    try {
        const querySnapshot = await q.get();
        let records = [];
        querySnapshot.forEach(doc => {
            records.push(doc.data());
        });
        
        // 日付でソートして最新5件を取得
        records.sort((a, b) => new Date(b.date) - new Date(a.date));
        return records.slice(0, 5);
    } catch (error) {
        console.error("Error fetching recent records:", error);
        return [];
    }
}

/**
 * Gemini APIを呼び出して報告文を生成する関数
 * @param {Object} user - 利用者情報 (nicknameを含む)
 * @param {string} staffName - スタッフ名
 * @param {string} activityNotes - 当日の活動メモ
 * @param {Object|null} revisionRequest - 修正リクエスト (instruction, originalReport)
 * @param {Array<Object>} recentRecords - 過去の記録
 * @returns {Promise<string>} - 生成された報告文
 */
async function generateReportWithAI(user, staffName, activityNotes, revisionRequest, recentRecords) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in environment variables.");
    }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    const recentHistory = recentRecords.map(r => 
        `日付: ${r.date}\n内容:\n宿題: ${r.homework || '記載なし'}\nプリント学習: ${r.worksheet || '記載なし'}\nツリー式学習: ${r.learning || '記載なし'}\nプログラム: ${r.program || '記載なし'}\n自由時間: ${r.freetime || '記載なし'}\n連絡事項・特記事項: ${r.notes || '記載なし'}`
    ).join('\n---\n');

    let systemPrompt = `あなたは児童発達支援・放課後等デイサービスのスタッフを支援する、プロのライターアシスタントです。
子どもたちの一日の活動内容のメモをもとに、保護者向けに自然で丁寧な文体の日報文（ツリー通信）を作成してください。

【日報の構成ルール】
1. 子どもの名前（敬称は「くん」か「ちゃん」を適切に判断）を冒頭に記載する。
2. 続けて、担当スタッフ名のあいさつから始めます。その後に改行を2つ入れて、「本日のツリー通信です。」と必ず記載してください。（例：「こんにちは、〇〇です！\\n\\n本日のツリー通信です。」）
3. 活動内容は「宿題」「プリント学習」「ツリー式学習」「プログラム」「自由時間」「粗大運動」「連絡事項」などに適切に分類し、具体的に記述する。メモに分類名がなくても、内容から推測して分類する。**内部連絡メモの内容は絶対に含めないでください。**
4. 事実ベースで書き、過度な評価や誇張は避ける。
5. 表現にバリエーションを持たせ、「楽しそうでした」の繰り返しは避ける。
6. 日報の末尾に使われがちな定型文（例：「今日も笑顔あふれる一日でした」「また次回も〜」）は**記載しない**。
7. **絵文字は一切使用しない**。
8. 文末に「印象的でした。」、「頼もしかったです」、「魅力的でした」という表現は使わない。

【表現スタイル】
- あたたかく、親しみのある文体で。
- 評価語（すごい・えらい・上手など）は控えめにし、努力や工夫を事実で伝える。
- 子どもの様子が自然にイメージできるよう、表情や会話、動作を描写する。
- 箇条書きではなく、自然な文章で構成する。

【品質向上のための参考例】
以下の例は、簡潔なメモからどのように様子を具体的に描写するかの良い手本です。この品質を目指してください。

---
入力メモ:
「たろうくん
宿題は、国語の漢字ドリルと算数の計算カード
プログラムは、お月見のうさぎ作り
自由時間は、パズル」

適切な出力例:
「たろうくん

こんにちは、〇〇です！

本日のツリー通信です。

宿題では、国語の漢字ドリルと算数の計算カードに取り組みました。漢字は、一文字ずつ丁寧に書こうと意識しており、計算カードもテンポよく読み進めていました。
プログラムでは、お月見にちなんだうさぎの制作を行いました。耳の形や顔のパーツをバランスよく貼ることにこだわりながら、楽しそうに取り組んでいました。
自由時間には、パズルを選んでじっくり挑戦していました。ピースをひとつひとつ確かめながら、集中して完成を目指す姿が見られました。」
---
`;
    
    let userQuery;

    if (revisionRequest) {
        systemPrompt += `\n\nあなたは、一度生成した文章に対して「もう少し詳しく」「もっと簡潔に」「表現を変えて」といった指示を受け取り、文章を修正する能力も持っています。`;

        const instructionText = {
            longer: 'もう少し文章を長く、具体的な様子が伝わるようにしてください。',
            shorter: 'もっと簡潔に、要点をまとめてください。',
            rephrase: '同じ意味で、違う表現を使って文章を書き直してください。'
        }[revisionRequest.instruction];

        userQuery = `以下の日報を、指示に従って修正してください。元の文脈や良い点は維持しつつ、改善してください。

【指示】
${instructionText}

【元の日報】
${revisionRequest.originalReport}

【参考情報：この報告を作成した際の元の日々の活動メモ】
${activityNotes}

【参考：この子の最近の活動記録】
${recentHistory || '最近の記録はありません。'}
`;
    } else {
         userQuery = `以下の情報をもとに、上記のルールに従って保護者向けの日報を作成してください。

【子供の呼び方】
${user.nickname}

【担当スタッフ】
${staffName}

【本日の活動内容メモ】
${activityNotes}

【参考：この子の最近の活動記録】
${recentHistory || '最近の記録はありません。'}
`;
    }

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const candidate = result.candidates?.[0];

    if (candidate && candidate.content?.parts?.[0]?.text) {
        return candidate.content.parts[0].text;
    } else {
        let errorText = "エラー: レポートの生成に失敗しました。";
        if (result.promptFeedback?.blockReason) {
            errorText += ` 理由: ${result.promptFeedback.blockReason}`;
        }
        throw new Error(errorText);
    }
}

/**
 * Netlify Function のメインハンドラー
 */
exports.handler = async (event, context) => {
    // CORS (Cross-Origin Resource Sharing) ヘッダー
    const headers = {
        'Access-Control-Allow-Origin': '*', // すべてのオリジンを許可 (本番環境では '*' を Netlify の URL に置き換えることを推奨)
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // OPTIONSリクエスト（プリフライトリクエスト）への対応
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers,
            body: ''
        };
    }

    // POSTリクエスト以外の拒否
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!serviceAccount || !admin.apps.length) {
         console.error('Firebase Admin is not initialized.');
         return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "サーバー内部エラー: Firebase Admin SDKが初期化されていません。" })
        };
    }

    try {
        const body = JSON.parse(event.body);
        const { appId, user, staffName, activityNotes, revisionRequest } = body;

        if (!appId || !user || !staffName || !activityNotes) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Bad Request: 必須パラメータが不足しています。" })
            };
        }

        // 1. Firestoreから過去の記録を取得
        const recentRecords = await getRecentRecordsForUser(appId, user.id);

        // 2. Gemini APIを呼び出し
        const generatedText = await generateReportWithAI(user, staffName, activityNotes, revisionRequest, recentRecords);

        // 3. 成功レスポンスを返す
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ report: generatedText })
        };

    } catch (error) {
        console.error('Error in Netlify function:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: `サーバー内部エラー: ${error.message}` })
        };
    }
};