# APIクライアント仕様

最終更新: 2025年4月

- タイムアウト: 30秒（`src/config.ts` で設定）
- リトライ: 失敗時に3回まで（`src/config.ts` で設定）
- 接続先: `https://api.example.com/v1`
/*******************************************************************************
    ○○株式会社様向け説明欄自動追記システム用テスト
    概要　　:BookCategoryTriggerに対するテストを行う
    作成者　: 細見悠依
    作成日　: 2026/10/26
*******************************************************************************/
@isTest
private class BookCategoryTriggerTestTwoCase {
    //メソッドに共通して使用する定数
    private static final String NAME_CONTAINING_KEYWORD = '練習用本';
    private static final String NAME_NOT_CONTAINING_KEYWORD = '練習用';
    private static final String EXISTING_DESCRIPTION = '既存の説明です。';
    private static final String CATEGORY_TEXT = BookCategoryTriggerHandler.CATEGORY_TEXT;
    private static final Integer MAX_LENGTH = Schema.SObjectType.Merchandise__c.fields.Description__c.getLength();
    // 通常のケース 6つ × 167件 = 1002件
    private static final Integer NORMAL_CASE_SIZE = 167;
    //通常のケース数
    private static final Integer CASE_COUNT = 6;
    // 最大文字数のケース数
    private static final Integer LONG_CASE_SIZE = 2;
    //最大文字数メソッドのケース数
    private static final Integer LONG_CASE_COUNT = 8;
    // 更新で「本」を含ませるために、商品名の末尾に付ける文字
    private static final String BOOK_KEYWORD = BookCategoryTriggerHandler.BOOK_KEYWORD;
    // 更新で「本」を含ませないために、商品名の末尾に付ける文字
    private static final String UPDATED_SUFFIX = '更新後';
    // 通常の更新メソッドのケース数（8つ × 167件 = 1336件）
    private static final Integer UPDATE_CASE_COUNT = 8;
    // 最大文字数の更新メソッドのケース数
    private static final Integer UPDATE_LONG_CASE_COUNT = 4;

    /**通常の6ケースを一度に登録しても、想定通りの結果になることを確認する */
    @isTest
    static void insertMixedCases() {
        List<Merchandise__c> merchandises = new List<Merchandise__c>();
        List<String> expectedDescriptions = new List<String>();
        for (Integer i = 1; i <= NORMAL_CASE_SIZE; i++) {
            for (Integer j = 1; j <= CASE_COUNT; j++) {
                String caseName = 'ケース:' + j + '順番:' + i;

                switch on j {
                    when 1 {
                        //「本」あり、「説明」あり
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 2 {
                        //「本」あり、「説明」なし
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD
                            )
                        );
                        expectedDescriptions.add(CATEGORY_TEXT);
                    }
                    when 3 {
                        //「本」なし、「説明」なし
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD
                            )
                        );
                        expectedDescriptions.add(null);
                    }
                    when 4 {
                        //「本」なし、「説明」あり
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(EXISTING_DESCRIPTION);
                    }
                    when 5 {
                        //「本」あり、「説明」追記済み
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION +
                                    CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 6 {
                        //「本」なし、「説明」追記済み
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION +
                                    CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                }
            }
        }

        //エラーが出ても止まらないようにDatabase.insertを用いる
        Test.startTest();
        Database.insert(merchandises, false);
        Test.stopTest();

        List<Merchandise__c> results = [
            SELECT Name, Description__c
            FROM Merchandise__c
            WHERE Id IN :merchandises
        ];

        Map<Id, Merchandise__c> resultMap = new Map<Id, Merchandise__c>(
            results
        );
        List<String> actualDescriptions = new List<String>();

        for (Merchandise__c merchandise : merchandises) {
            Merchandise__c result = resultMap.get(merchandise.Id);
            if (result == null) {
                actualDescriptions.add('取得できませんでした');
            } else {
                actualDescriptions.add(result.Description__c);
            }
        }
        Assert.areEqual(
            expectedDescriptions,
            actualDescriptions,
            '全件の説明が期待通りであること'
        );
    }

    /**最大文字数にかかわるケースを登録しても、想定通りの結果になることを確認する */
    @isTest
    static void insertMaxLengthCases() {
        //追記する前の最大文字数
        Integer maxLengthBeforeAppend = MAX_LENGTH - CATEGORY_TEXT.length();
        //説明が最大文字数ちょうど
        String maxLengthText = 'あ'.repeat(MAX_LENGTH);
        //追記すると最大文字数ちょうど
        String justFitText = 'あ'.repeat(maxLengthBeforeAppend);
        //追記すると一文字超過
        String overLimitText = 'あ'.repeat(maxLengthBeforeAppend + 1);

        List<Merchandise__c> merchandises = new List<Merchandise__c>();
        List<String> expectedDescriptions = new List<String>();
        for (Integer i = 1; i <= LONG_CASE_SIZE; i++) {
            for (Integer j = 1; j <= LONG_CASE_COUNT; j++) {
                String caseName = 'ケース:' + j + '順番:' + i;

                switch on j {
                    when 1 {
                        //「本」あり、「説明」が最大文字数ちょうど
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = maxLengthText
                            )
                        );
                        expectedDescriptions.add(maxLengthText);
                    }
                    when 2 {
                        //「本」あり、追記すると最大文字数ちょうど
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = justFitText
                            )
                        );
                        expectedDescriptions.add(justFitText + CATEGORY_TEXT);
                    }
                    when 3 {
                        //「本」あり、追記すると1文字超過
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = overLimitText
                            )
                        );
                        expectedDescriptions.add(overLimitText);
                    }
                    when 4 {
                        //「本」あり、「説明」が追記済みで最大文字数
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = justFitText + CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(justFitText + CATEGORY_TEXT);
                    }
                    when 5 {
                        //「本」なし、「説明」が最大文字数ちょうど
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = maxLengthText
                            )
                        );
                        expectedDescriptions.add(maxLengthText);
                    }
                    when 6 {
                        //「本」なし、追記すると最大文字数ちょうどになる説明
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = justFitText
                            )
                        );
                        expectedDescriptions.add(justFitText);
                    }
                    when 7 {
                        //「本」なし、追記すると1文字超過になる説明
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = overLimitText
                            )
                        );
                        expectedDescriptions.add(overLimitText);
                    }
                    when 8 {
                        //「本」なし、「説明」が追記済みで最大文字数
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = justFitText + CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(justFitText + CATEGORY_TEXT);
                    }
                }
            }
        }

        //エラーが出ても止まらないようにDatabase.insertを用いる
        Test.startTest();
        Database.insert(merchandises, false);
        Test.stopTest();

        List<Merchandise__c> results = [
            SELECT Name, Description__c
            FROM Merchandise__c
            WHERE Id IN :merchandises
        ];

        Map<Id, Merchandise__c> resultMap = new Map<Id, Merchandise__c>(
            results
        );
        List<String> actualDescriptions = new List<String>();

        for (Merchandise__c merchandise : merchandises) {
            Merchandise__c result = resultMap.get(merchandise.Id);
            if (result == null) {
                actualDescriptions.add('取得できませんでした');
            } else {
                actualDescriptions.add(result.Description__c);
            }
        }
        Assert.areEqual(
            expectedDescriptions,
            actualDescriptions,
            '全件の説明が期待通りであること'
        );
    }

    /**通常の6ケースを一度に更新しても、想定通りの結果になることを確認する */
    @isTest
    static void updateMixedCases() {
        List<Merchandise__c> merchandises = new List<Merchandise__c>();
        List<String> expectedDescriptions = new List<String>();
        for (Integer i = 1; i <= NORMAL_CASE_SIZE; i++) {
            for (Integer j = 1; j <= UPDATE_CASE_COUNT; j++) {
                String caseName = 'ケース:' + j + '順番:' + i;

                switch on j {
                    when 1 {
                        //更新前：「本」なし、「説明」あり（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 2 {
                        //更新前：「本」なし、「説明」なし（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD
                            )
                        );
                        expectedDescriptions.add(CATEGORY_TEXT);
                    }
                    when 3 {
                        //更新前：「本」なし、「説明」なし（「本」を含ませない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD
                            )
                        );
                        expectedDescriptions.add(null);
                    }
                    when 4 {
                        //更新前：「本」なし、「説明」あり（「本」を含ませない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(EXISTING_DESCRIPTION);
                    }
                    when 5 {
                        //更新前：「本」なし、「説明」追記済み（更新で「本」を含ませても、二重に追記されない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION +
                                    CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 6 {
                        //更新前：「本」あり、「説明」あり（登録時に追記され、更新で二重に追記されない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 7 {
                        //更新前：「本」なし、「説明」追記済み（「本」を含ませない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION +
                                    CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                    when 8 {
                        //更新前：「本」あり、「説明」あり（登録時に追記され、更新で「本」を外しても説明は変わらない）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_CONTAINING_KEYWORD,
                                Description__c = EXISTING_DESCRIPTION
                            )
                        );
                        expectedDescriptions.add(
                            EXISTING_DESCRIPTION + CATEGORY_TEXT
                        );
                    }
                }
            }
        }

        //更新前の商品を登録する。エラーが出ても止まらないようにDatabase.insertを用いる
        List<Database.SaveResult> insertResults = Database.insert(
            merchandises,
            false
        );

        Integer insertFailedCount = 0;
        for (Database.SaveResult insertResult : insertResults) {
            if (!insertResult.isSuccess()) {
                insertFailedCount++;
            }
        }
        Assert.areEqual(
            0,
            insertFailedCount,
            '更新前の商品が、全件登録できること'
        );

        List<Merchandise__c> updates = new List<Merchandise__c>();
        for (Merchandise__c merchandise : merchandises) {
            if (
                merchandise.Name.startsWith('ケース:1') ||
                merchandise.Name.startsWith('ケース:2') ||
                merchandise.Name.startsWith('ケース:5') ||
                merchandise.Name.startsWith('ケース:6')
            ) {
                //商品名に「本」を含むように更新する
                updates.add(
                    new Merchandise__c(
                        Id = merchandise.Id,
                        Name = merchandise.Name + BOOK_KEYWORD
                    )
                );
            } else if (merchandise.Name.startsWith('ケース:8')) {
                //商品名から「本」を外すように更新する
                updates.add(
                    new Merchandise__c(
                        Id = merchandise.Id,
                        Name = merchandise.Name.replace(
                            NAME_CONTAINING_KEYWORD,
                            NAME_NOT_CONTAINING_KEYWORD
                        ) + UPDATED_SUFFIX
                    )
                );
            } else {
                //商品名に「本」を含まないように更新する
                updates.add(
                    new Merchandise__c(
                        Id = merchandise.Id,
                        Name = merchandise.Name + UPDATED_SUFFIX
                    )
                );
            }
        }

        //エラーが出ても止まらないようにDatabase.updateを用いる
        Test.startTest();
        List<Database.SaveResult> updateResults = Database.update(
            updates,
            false
        );
        Test.stopTest();

        Integer updateFailedCount = 0;
        for (Database.SaveResult updateResult : updateResults) {
            if (!updateResult.isSuccess()) {
                updateFailedCount++;
            }
        }
        Assert.areEqual(0, updateFailedCount, '全件が更新できること');

        List<Merchandise__c> results = [
            SELECT Name, Description__c
            FROM Merchandise__c
            WHERE Id IN :merchandises
        ];

        Map<Id, Merchandise__c> resultMap = new Map<Id, Merchandise__c>(
            results
        );
        List<String> actualDescriptions = new List<String>();

        for (Merchandise__c merchandise : merchandises) {
            Merchandise__c result = resultMap.get(merchandise.Id);
            if (result == null) {
                actualDescriptions.add('取得できませんでした');
            } else {
                actualDescriptions.add(result.Description__c);
            }
        }
        Assert.areEqual(
            expectedDescriptions,
            actualDescriptions,
            '更新後の全件の説明が期待通りであること'
        );
    }

    /**最大文字数にかかわるケースを更新しても、想定通りの結果になることを確認する */
    @isTest
    static void updateMaxLengthCases() {
        //追記する前の最大文字数
        Integer maxLengthBeforeAppend = MAX_LENGTH - CATEGORY_TEXT.length();
        //説明が最大文字数ちょうど
        String maxLengthText = 'あ'.repeat(MAX_LENGTH);
        //追記すると最大文字数ちょうど
        String justFitText = 'あ'.repeat(maxLengthBeforeAppend);
        //追記すると一文字超過
        String overLimitText = 'あ'.repeat(maxLengthBeforeAppend + 1);

        List<Merchandise__c> merchandises = new List<Merchandise__c>();
        List<String> expectedDescriptions = new List<String>();
        for (Integer i = 1; i <= LONG_CASE_SIZE; i++) {
            for (Integer j = 1; j <= UPDATE_LONG_CASE_COUNT; j++) {
                String caseName = 'ケース:' + j + '順番:' + i;

                switch on j {
                    when 1 {
                        //更新前：「本」なし、追記すると最大文字数ちょうど（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = justFitText
                            )
                        );
                        expectedDescriptions.add(justFitText + CATEGORY_TEXT);
                    }
                    when 2 {
                        //更新前：「本」なし、追記すると1文字超過（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = overLimitText
                            )
                        );
                        expectedDescriptions.add(overLimitText);
                    }
                    when 3 {
                        //更新前：「本」なし、「説明」が追記済みで最大文字数（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = justFitText + CATEGORY_TEXT
                            )
                        );
                        expectedDescriptions.add(justFitText + CATEGORY_TEXT);
                    }
                    when 4 {
                        //更新前：「本」なし、「説明」が最大文字数ちょうど（更新で「本」を含ませる）
                        merchandises.add(
                            new Merchandise__c(
                                Name = caseName + NAME_NOT_CONTAINING_KEYWORD,
                                Description__c = maxLengthText
                            )
                        );
                        expectedDescriptions.add(maxLengthText);
                    }
                }
            }
        }

        //更新前の商品を登録する。エラーが出ても止まらないようにDatabase.insertを用いる
        List<Database.SaveResult> insertResults = Database.insert(
            merchandises,
            false
        );

        Integer insertFailedCount = 0;
        for (Database.SaveResult insertResult : insertResults) {
            if (!insertResult.isSuccess()) {
                insertFailedCount++;
            }
        }
        Assert.areEqual(
            0,
            insertFailedCount,
            '更新前の商品が、全件登録できること'
        );

        //更新する商品を作る（IdとNameだけを渡して、説明は更新しない）。全件、「本」を含むように更新する
        List<Merchandise__c> updates = new List<Merchandise__c>();
        for (Merchandise__c merchandise : merchandises) {
            updates.add(
                new Merchandise__c(
                    Id = merchandise.Id,
                    Name = merchandise.Name + BOOK_KEYWORD
                )
            );
        }

        //エラーが出ても止まらないようにDatabase.updateを用いる
        Test.startTest();
        List<Database.SaveResult> updateResults = Database.update(
            updates,
            false
        );
        Test.stopTest();

        Integer updateFailedCount = 0;
        for (Database.SaveResult updateResult : updateResults) {
            if (!updateResult.isSuccess()) {
                updateFailedCount++;
            }
        }
        Assert.areEqual(0, updateFailedCount, '全件が更新できること');

        List<Merchandise__c> results = [
            SELECT Name, Description__c
            FROM Merchandise__c
            WHERE Id IN :merchandises
        ];

        Map<Id, Merchandise__c> resultMap = new Map<Id, Merchandise__c>(
            results
        );
        List<String> actualDescriptions = new List<String>();

        for (Merchandise__c merchandise : merchandises) {
            Merchandise__c result = resultMap.get(merchandise.Id);
            if (result == null) {
                actualDescriptions.add('取得できませんでした');
            } else {
                actualDescriptions.add(result.Description__c);
            }
        }
        Assert.areEqual(
            expectedDescriptions,
            actualDescriptions,
            '更新後の全件の説明が期待通りであること'
        );
    }
}
