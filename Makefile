BINARY := bin/clash-exporter

.PHONY: build test lint

# build: 编译单二进制到 bin/clash-exporter
build:
	go build -o $(BINARY) .

# test: 运行全部单元测试
test:
	go test ./...

# lint: 静态检查（go vet）+ 格式检查（gofmt），格式不合规即失败
lint:
	go vet ./...
	@files="$$(gofmt -l .)"; \
	if [ -n "$$files" ]; then \
		echo "以下文件未通过 gofmt:"; \
		echo "$$files"; \
		exit 1; \
	fi
