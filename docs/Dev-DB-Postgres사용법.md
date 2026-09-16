# Podium Postgres 사용법

로컬 개발용 Postgres(Docker 컨테이너)에 접속하고 데이터를 조회/수정하는 방법.

| 항목 | 값 |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `podium` |
| User | `podium` |
| Password | `podium` |

> 위 값은 `docker-compose.yml`과 `backend/.env`에 박혀 있음. 바꾸려면 두 곳 모두 동기화.

---

## 1. 접속 방법

### 방법 A — Docker 컨테이너 안의 psql (추가 설치 0, 가장 빠름)

```bash
docker compose exec postgres psql -U podium -d podium
```

- `-U podium` : 유저
- `-d podium` : DB 이름
- 같은 컨테이너 내부 호출이라 비밀번호 안 물어봄

> Docker가 떠 있어야 함 (`docker compose up -d postgres`).

### 방법 B — 호스트에서 psql 직접

```bash
brew install postgresql       # 클라이언트만 필요. 서버 동시 설치되지만 안 띄워도 됨.
psql -h localhost -U podium -d podium
# 비밀번호: podium
```

### 방법 C — GUI (DBeaver / TablePlus / pgAdmin / Postico)

→ 아래 [GUI 사용법(DBeaver)](#3-gui-사용법-dbeaver) 참고.

---

## 2. psql 명령어 (MySQL 사용자용 매핑)

psql 안에서는 두 가지 명령이 섞임:
- **SQL** : 표준 SQL. `;`로 끝맺어야 실행됨.
- **메타 명령** : `\`로 시작. `;` 없이 즉시 실행.

| 하고 싶은 일 | MySQL | PostgreSQL (psql) |
|---|---|---|
| 전체 DB 목록 | `SHOW DATABASES;` | `\l` |
| **DB 전환** | `USE dbname;` | `\c dbname` (재연결 발생) |
| 테이블 목록 | `SHOW TABLES;` | `\dt` |
| 테이블 구조 | `DESCRIBE users;` | `\d users` |
| 더 자세히 | `SHOW CREATE TABLE users;` | `\d+ users` |
| 인덱스 목록 | `SHOW INDEX FROM users;` | `\di` |
| 현재 접속 정보 | `SELECT user(), database();` | `\conninfo` |
| 명령 이력 | `history` | `\s` |
| 도움말 | `help` | `\?` (메타 명령), `\h SELECT` (SQL 도움말) |
| 나가기 | `\q` | `\q` |

### MySQL과의 핵심 차이

1. **`USE`가 없다.** 연결이 DB에 묶여 있어서 `\c dbname`으로 재연결.
2. **스키마(schema) 개념.** 한 DB 안에서 namespace로 더 잘게 나뉨. 우리는 기본 `public` 스키마 사용.
3. **자동완성**: `Tab` 키로 테이블/컬럼 이름 자동완성됨.
4. **여러 줄 입력**: `;` 칠 때까지 한 쿼리로 봄. 프롬프트가 `podium=>`에서 `podium->`으로 바뀌면 "아직 안 끝났다"는 뜻.

---

## 자주 쓰는 SQL

### 데이터 살펴보기
```sql
-- 우리 테이블 11개 확인 (10개 도메인 + alembic_version)
\dt

-- 사용자 수
SELECT count(*) FROM users;

-- 최근 가입 5명
SELECT user_id, email, created_at FROM users ORDER BY created_at DESC LIMIT 5;

-- 사용자별 프로젝트 수
SELECT u.email, count(p.project_id) AS project_count
FROM users u
LEFT JOIN projects p ON p.user_id = u.user_id
GROUP BY u.user_id
ORDER BY project_count DESC;

-- 특정 세션의 청크 모두
SELECT chunk_index, t_start, t_end, file_path
FROM chunks
WHERE session_id = 1
ORDER BY chunk_index;
```

### Alembic 상태 확인
```sql
-- 현재 적용된 마이그레이션 버전
SELECT * FROM alembic_version;
```

### 테스트 데이터 빠르게 넣기
```sql
INSERT INTO users (email, password_hash) VALUES ('test@example.com', 'dummy');
INSERT INTO projects (user_id, title) VALUES (1, '논문 발표');
INSERT INTO sessions (project_id, status) VALUES (1, 'processing');
```

### 데이터 정리 (개발 중에만!)
```sql
-- 특정 사용자와 그 아래 모든 것 (cascade로 자동 삭제됨)
DELETE FROM users WHERE email = 'test@example.com';

-- 전체 초기화 (조심 — 모든 데이터 삭제)
TRUNCATE TABLE users CASCADE;
```

---

## 3. GUI 사용법 (DBeaver)

### 설치
```bash
brew install --cask dbeaver-community
```
또는 https://dbeaver.io/download/

### 연결 만들기
1. DBeaver 실행 → 좌상단 **콘센트 아이콘 (New Database Connection)** 클릭
2. **PostgreSQL** 선택 → Next
3. 다음 입력:
   - Host: `localhost`
   - Port: `5432`
   - Database: `podium`
   - Username: `podium`
   - Password: `podium`
4. **Test Connection** → 성공 시 드라이버 자동 다운로드
5. **Finish**

### 트리 구조 이해
```
podium (연결 이름)
└── Databases
    └── podium
        └── Schemas
            └── public               ← 우리 테이블이 여기
                ├── Tables (11)
                │   ├── users
                │   ├── projects
                │   ├── sessions
                │   ├── chunks
                │   ├── ...
                │   └── alembic_version
                ├── Views
                ├── Indexes
                └── Foreign Keys
```

### 자주 쓰는 기능

| 동작 | 방법 |
|---|---|
| 테이블 데이터 보기 | 테이블 더블클릭 → 상단 **Data** 탭 |
| 컬럼 구조 보기 | 테이블 더블클릭 → **Properties** 탭 (또는 Columns) |
| ERD 자동 생성 | `public` 스키마 우클릭 → **View Diagram** |
| SQL 실행 | `Ctrl/Cmd + ]` (새 SQL 편집기) → 쿼리 입력 → `Ctrl/Cmd + Enter` |
| 행 추가/수정 | Data 탭에서 직접 편집 → 하단 **Save** 또는 `Ctrl/Cmd + S` |
| 행 삭제 | 행 선택 → `Delete` 키 → Save |
| 데이터 export | 테이블 우클릭 → **Export Data** (CSV/JSON/SQL Insert) |
| 데이터 import | 테이블 우클릭 → **Import Data** |

### 첫 ERD 보는 법 (Quick Start)
1. 좌측 트리 펼치기 → `podium > Schemas > public`
2. `public` **우클릭** → **View Diagram**
3. 잠시 기다리면 11개 테이블 + 관계선이 자동 배치됨
4. 마우스로 박스 드래그해서 정리 가능
5. 우상단 저장 버튼 → 워크스페이스에 보관됨 (DBeaver 다시 열어도 유지)

---

## 4. 주의사항 (Alembic과의 관계)

**DDL(`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`)을 GUI/psql에서 직접 치지 말 것.**

이유: Alembic이 "현재 DB가 어떤 상태인지" 모름. 다음 `alembic revision --autogenerate` 돌릴 때 그 변경을 다시 마이그레이션으로 만들려고 함 → 충돌.

**올바른 흐름**:
1. `backend/app/models/*.py` 수정
2. `alembic revision --autogenerate -m "..."` → 마이그레이션 파일 생성
3. 파일 검토
4. `alembic upgrade head` → DB 적용

**GUI/psql로 OK인 것**:
- 모든 SELECT
- INSERT / UPDATE / DELETE (개발/테스트 데이터)
- 데이터 살펴보기, ERD 생성, export

**GUI/psql로 절대 X**:
- CREATE / ALTER / DROP TABLE
- 컬럼 추가/삭제
- 인덱스 추가/삭제 (성능 실험 후엔 모델로 반영)

---

## 5. 자주 막히는 곳

### `psql: could not connect to server`
→ Postgres 컨테이너가 안 떠 있음. `docker compose up -d postgres` 후 `docker compose ps`로 healthy 확인.

### `FATAL: password authentication failed for user "podium"`
→ 비밀번호 틀림 또는 호스트가 잘못됨. `backend/.env`의 `DATABASE_URL`과 GUI 입력값이 일치하는지 확인.

### `relation "users" does not exist`
→ 마이그레이션이 안 돌았음. `backend/`에서 `alembic upgrade head` 실행.

### GUI에 컬럼이 안 나옴
→ 트리에서 우클릭 → **Refresh** (F5). DBeaver는 가끔 캐시가 안 갱신됨.

### psql 한글 깨짐
→ 보통 잘 됨. 깨지면 `\encoding UTF8` 한 번 실행.
