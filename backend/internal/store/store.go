package store

import (
	"bytes"
	"context"
	"io"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	UseSSL    bool
}

type Store struct {
	core   *minio.Core
	client *minio.Client
	bucket string
}

func New(ctx context.Context, cfg Config) (*Store, error) {
	opts := &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	}
	cl, err := minio.New(cfg.Endpoint, opts)
	if err != nil {
		return nil, err
	}
	coreCl, err := minio.NewCore(cfg.Endpoint, opts)
	if err != nil {
		return nil, err
	}
	s := &Store{client: cl, core: coreCl, bucket: cfg.Bucket}
	if err := s.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func NewWithRetry(ctx context.Context, cfg Config, attempts int) (*Store, error) {
	var last error
	for i := 0; i < attempts; i++ {
		s, err := New(ctx, cfg)
		if err == nil {
			return s, nil
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, last
}

func (s *Store) ensureBucket(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if !ok {
		return s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{})
	}
	return nil
}

func (s *Store) Bucket() string { return s.bucket }

func (s *Store) Ping(ctx context.Context) bool {
	_, err := s.client.ListBuckets(ctx)
	return err == nil
}

// BeginMultipart returns a MinIO upload id for objectKey.
func (s *Store) BeginMultipart(ctx context.Context, objectKey, contentType string) (string, error) {
	return s.core.NewMultipartUpload(ctx, s.bucket, objectKey, minio.PutObjectOptions{
		ContentType: contentType,
	})
}

// UploadPart stores one chunk; part numbers start at 1.
func (s *Store) UploadPart(ctx context.Context, uploadID, objectKey string, partNumber int, data []byte) (etag string, err error) {
	part, err := s.core.PutObjectPart(ctx, s.bucket, objectKey, uploadID, partNumber,
		bytes.NewReader(data), int64(len(data)), minio.PutObjectPartOptions{})
	if err != nil {
		return "", err
	}
	return part.ETag, nil
}

// CompletedParts reports which part numbers MinIO already holds, enabling resume.
func (s *Store) CompletedParts(ctx context.Context, uploadID, objectKey string) (map[int]bool, error) {
	got := map[int]bool{}
	marker := 0
	for {
		res, err := s.core.ListObjectParts(ctx, s.bucket, objectKey, uploadID, marker, 1000)
		if err != nil {
			return nil, err
		}
		for _, p := range res.ObjectParts {
			got[p.PartNumber] = true
		}
		if !res.IsTruncated {
			break
		}
		marker = res.NextPartNumberMarker
	}
	return got, nil
}

func (s *Store) CompleteMultipart(ctx context.Context, uploadID, objectKey string, parts []minio.CompletePart) error {
	_, err := s.core.CompleteMultipartUpload(ctx, s.bucket, objectKey, uploadID, parts, minio.PutObjectOptions{})
	return err
}

func (s *Store) AbortMultipart(ctx context.Context, uploadID, objectKey string) error {
	return s.core.AbortMultipartUpload(ctx, s.bucket, objectKey, uploadID)
}

func (s *Store) PresignGet(ctx context.Context, objectKey string) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, s.bucket, objectKey, 0, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// GetObject streams an object; used by the authenticated download proxy so the
// browser never needs direct access to the object store.
func (s *Store) GetObject(ctx context.Context, objectKey string) (io.ReadCloser, minio.ObjectInfo, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, minio.ObjectInfo{}, err
	}
	info, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, minio.ObjectInfo{}, err
	}
	return obj, info, nil
}
